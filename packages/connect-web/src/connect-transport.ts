import type {
  Message,
  MessageType,
  MethodInfo,
  ServiceType,
} from "@bufbuild/protobuf";
import { ConnectError } from "./connect-error.js";
import { codeFromHttpStatus, StatusCode } from "./status-code.js";
import { parseBinaryHeader, percentDecodeHeader } from "./http-headers.js";
import { Status } from "./grpc/status/v1/status_pb.js";
import type {
  ClientTransport,
  ClientResponse,
  ClientRequest,
  ClientCallOptions,
} from "./client-transport.js";
import type { BinaryReadOptions, BinaryWriteOptions } from "@bufbuild/protobuf";
import {
  chainClientInterceptors,
  ClientInterceptor,
} from "./client-interceptor.js";

export interface ConnectTransportOptions {
  /**
   * Base URI for all HTTP requests.
   *
   * Requests will be made to <baseUrl>/<package>.<service>/method
   *
   * Example: `baseUrl: "https://example.com/my-api"`
   *
   * This will make a `POST /my-api/my_package.MyService/Foo` to
   * `example.com` via HTTPS.
   */
  baseUrl: string;

  /**
   * Options for the binary wire format.
   */
  binaryOptions?: Partial<BinaryReadOptions & BinaryWriteOptions>;

  interceptors?: ClientInterceptor[];
}

export function createConnectTransport(
  options: ConnectTransportOptions
): ClientTransport {
  const transportOptions = options;
  return {
    call<I extends Message, O extends Message>(
      service: ServiceType,
      method: MethodInfo<I, O>,
      options: ClientCallOptions
    ): [ClientRequest<I>, ClientResponse<O>] {
      const [request, fetchResponse] = createRequest(
        service.typeName,
        method.name,
        options,
        transportOptions
      );
      const response = createResponse(
        method.O,
        options,
        transportOptions,
        fetchResponse
      );
      if (transportOptions.interceptors !== undefined) {
        return chainClientInterceptors(
          service,
          method,
          options,
          request,
          response,
          transportOptions.interceptors
        );
      }
      return [request, response];
    },
  };
}

function createRequest<I extends Message>(
  serviceTypeName: string,
  methodName: string,
  callOptions: ClientCallOptions,
  transportOptions: ConnectTransportOptions
): [ClientRequest<I>, Promise<Response>] {
  let resolveResponse: (value: Response) => void;
  let rejectResponse: (reason: unknown) => void;
  const responsePromise = new Promise<Response>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });

  let baseUrl = transportOptions.baseUrl;
  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.substring(0, baseUrl.length - 1);
  }
  const url = `${baseUrl}/${serviceTypeName}/${methodName}`;
  const abort = callOptions.abort ?? new AbortController().signal;
  const request: ClientRequest = {
    url,
    init: {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      mode: "cors",
    },
    abort,
    header: createRequestHeaders(callOptions),
    send(message: I, callback) {
      const data = message.toBinary(transportOptions.binaryOptions);
      const body = new Uint8Array(data.length + 5);
      body[0] = FrameType.DATA; // first byte is frame type
      for (let dataLength = data.length, i = 4; i > 0; i--) {
        body[i] = dataLength % 256; // 4 bytes message length
        dataLength >>>= 8;
      }
      body.set(data, 5);
      fetch(this.url, {
        ...this.init,
        headers: this.header,
        signal: this.abort,
        body,
      })
        .then(resolveResponse)
        .catch(rejectResponse);
      // We cannot make a meaningful callback to send() via fetch.
      callback(undefined);
    },
  };

  return [request, responsePromise];
}

function createResponse<O extends Message>(
  messageType: MessageType<O>,
  callOptions: ClientCallOptions,
  transportOptions: ConnectTransportOptions,
  response: Response | Promise<Response>
): ClientResponse<O> {
  let isReading = false;
  let isRead = false;
  let readFrame: FrameReader | undefined;
  return {
    receive(handler): void {
      function close(reason?: unknown) {
        isRead = true;
        isReading = false;
        let error: ConnectError | undefined;
        if (reason instanceof ConnectError) {
          error = reason;
        } else if (reason !== undefined) {
          error = new ConnectError(String(reason));
        }
        handler.onClose(error);
      }
      if (isRead) {
        close("response already read");
        return;
      }
      if (isReading) {
        close("cannot read response concurrently");
        return;
      }
      Promise.resolve(response)
        .then((response) => {
          if (readFrame === undefined) {
            handler.onHeader?.(response.headers);
            const err =
              extractDetailsError(response.headers) ??
              extractHeadersError(response.headers) ??
              extractHttpStatusError(response);
            if (err) {
              close(err);
              return;
            }
            if (response.body === null) {
              close("missing response body");
              return;
            }
            try {
              readFrame = createFrameReader(response.body);
            } catch (e) {
              close(`failed to get response body reader: ${String(e)}`);
              return;
            }
          }
          isReading = true;
          readFrame()
            .then((frame) => {
              isReading = false;
              switch (frame.type) {
                case FrameType.DATA:
                  try {
                    handler.onMessage(
                      messageType.fromBinary(
                        frame.data,
                        transportOptions.binaryOptions
                      )
                    );
                  } catch (e) {
                    // prettier-ignore
                    close(`failed to deserialize message ${messageType.typeName}: ${String(e)}`);
                  }
                  break;
                case FrameType.TRAILER: {
                  const trailer = parseTrailerFrame(frame);
                  handler.onTrailer?.(trailer);
                  close(
                    extractDetailsError(trailer) ?? extractHeadersError(trailer)
                  );
                  break;
                }
              }
            })
            .catch(close);
        })
        .catch(close);
    },
  };
}

function createRequestHeaders(callOptions: ClientCallOptions): Headers {
  const header = new Headers({
    "Content-Type": "application/grpc-web+proto",
    "X-Grpc-Web": "1",
    "X-User-Agent": "@bufbuild/connect-web",
  });
  new Headers(callOptions.headers).forEach((value, key) =>
    header.set(key, value)
  );
  if (callOptions.timeout !== undefined) {
    header.set("grpc-timeout", `${callOptions.timeout}m`);
  }
  return header;
}

function extractHttpStatusError(response: Response): ConnectError | undefined {
  const code = codeFromHttpStatus(response.status);
  if (code === StatusCode.Ok) {
    return undefined;
  }
  return new ConnectError(
    percentDecodeHeader(response.headers.get("grpc-message") ?? ""),
    code
  );
}

function extractHeadersError(header: Headers): ConnectError | undefined {
  const value = header.get("grpc-status");
  if (value === null) {
    return undefined;
  }
  const code = parseInt(value);
  if (code === StatusCode.Ok) {
    return undefined;
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- condition is very much necessary to check code
  if (StatusCode[code] === undefined) {
    return new ConnectError(
      `invalid grpc-status: ${value}`,
      StatusCode.DataLoss
    );
  }
  return new ConnectError(
    percentDecodeHeader(header.get("grpc-message") ?? ""),
    code
  );
}

function extractDetailsError(header: Headers): ConnectError | undefined {
  const grpcStatusDetailsBin = header.get("grpc-status-details-bin");
  if (grpcStatusDetailsBin === null) {
    return undefined;
  }
  try {
    const status = parseBinaryHeader(grpcStatusDetailsBin, Status);
    // Prefer the protobuf-encoded data to the headers.
    if (status.code === StatusCode.Ok) {
      return undefined;
    }
    return new ConnectError(status.message, status.code, status.details);
  } catch (e) {
    return new ConnectError("invalid grpc-status-details-bin");
  }
}

function parseTrailerFrame(frame: TrailerFrame): Headers {
  const headers = new Headers();
  const lines = String.fromCharCode(...frame.data).split("\r\n");
  for (const line of lines) {
    if (line === "") {
      continue;
    }
    const i = line.indexOf(":");
    if (i > 0) {
      const name = line.substring(0, i).trim();
      const value = line.substring(i + 1).trim();
      headers.append(name, value);
    }
  }
  return headers;
}

enum FrameType {
  DATA = 0x00,
  TRAILER = 0x80,
}

interface DataFrame {
  type: FrameType.DATA;
  data: Uint8Array;
}
interface TrailerFrame {
  type: FrameType.TRAILER;
  data: Uint8Array;
}

type FrameReader = () => Promise<DataFrame | TrailerFrame>;

/**
 * Create a function that reads one frame per call from the given stream.
 */
function createFrameReader(stream: ReadableStream<Uint8Array>): FrameReader {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  function append(chunk: Uint8Array): void {
    const n = new Uint8Array(buffer.length + chunk.length);
    n.set(buffer);
    n.set(chunk, buffer.length);
    buffer = n;
  }
  async function readDataFrame(): Promise<DataFrame> {
    let dataLength: number | undefined;
    for (;;) {
      if (dataLength === undefined && buffer.byteLength >= 5) {
        dataLength = 0;
        for (let i = 1; i < 5; i++) {
          dataLength = (dataLength << 8) + buffer[i];
        }
      }
      if (dataLength !== undefined && buffer.byteLength >= dataLength) {
        break;
      }
      const result = await reader.read();
      if (result.done) {
        throw new ConnectError(
          "premature end of response body",
          StatusCode.DataLoss
        );
      }
      append(result.value);
    }
    const data = buffer.subarray(5, 5 + dataLength);
    buffer = buffer.subarray(5 + dataLength);
    return {
      type: FrameType.DATA,
      data,
    };
  }
  async function readTrailerFrame(): Promise<TrailerFrame> {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      append(result.value);
    }
    const data = buffer.subarray(5);
    buffer = new Uint8Array(0);
    return {
      type: FrameType.TRAILER,
      data,
    };
  }
  return async function readFrame(): Promise<DataFrame | TrailerFrame> {
    for (;;) {
      if (buffer.byteLength > 0) {
        switch (buffer[0]) {
          case FrameType.DATA:
            return readDataFrame();
          case FrameType.TRAILER:
            return readTrailerFrame();
        }
      }
      const result = await reader.read();
      if (result.done) {
        throw new ConnectError(
          "premature end of response body",
          StatusCode.DataLoss
        );
      }
      append(result.value);
    }
  };
}
