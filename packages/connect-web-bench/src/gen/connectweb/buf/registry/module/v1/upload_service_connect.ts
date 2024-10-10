// Copyright 2021-2024 The Connect Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// @generated by protoc-gen-connect-es v1.6.0 with parameter "ts_nocheck=false,target=ts"
// @generated from file buf/registry/module/v1/upload_service.proto (package buf.registry.module.v1, syntax proto3)
/* eslint-disable */

import { UploadRequest, UploadResponse } from "./upload_service_pb.js";
import { MethodKind } from "@bufbuild/protobuf";

/**
 * Upload contents.
 *
 * @generated from service buf.registry.module.v1.UploadService
 */
export const UploadService = {
  typeName: "buf.registry.module.v1.UploadService",
  methods: {
    /**
     * Upload contents for given set of Modules.
     *
     * Content consists of the Files: .proto files, license files, and documentation files.
     *
     * @generated from rpc buf.registry.module.v1.UploadService.Upload
     */
    upload: {
      name: "Upload",
      I: UploadRequest,
      O: UploadResponse,
      kind: MethodKind.Unary,
    },
  }
} as const;

