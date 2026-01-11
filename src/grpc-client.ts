// gRPC-Web client for Cloudflare Workers
// Uses grpc-web protocol to communicate with Rust backend

import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import {
  DriverListSchema,
  DriverIdRequestSchema,
  DriverSchema,
  PicTmpListSchema,
  PaginationRequestSchema,
  ICNonRegListSchema,
  TimeRangeRequestSchema,
  UpdateICNonRegRequestSchema,
  ICLogListSchema,
  ICLogWithDriverListSchema,
} from './gen/timecard_pb';
import { EmptySchema } from '@bufbuild/protobuf/wkt';

export class GrpcWebClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    // Remove trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async callGrpcWeb(
    service: string,
    method: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requestSchema: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    responseSchema: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const requestMessage = create(requestSchema, request);
    const requestBytes = toBinary(requestSchema, requestMessage);

    // gRPC-Web frame: 1 byte flag (0=uncompressed) + 4 bytes length + data
    const frame = new Uint8Array(5 + requestBytes.length);
    frame[0] = 0; // uncompressed
    const len = requestBytes.length;
    frame[1] = (len >> 24) & 0xff;
    frame[2] = (len >> 16) & 0xff;
    frame[3] = (len >> 8) & 0xff;
    frame[4] = len & 0xff;
    frame.set(requestBytes, 5);

    const url = `${this.baseUrl}/${service}/${method}`;

    // Use grpc-web-text (base64) format for better Cloudflare compatibility
    const base64Frame = btoa(String.fromCharCode(...frame));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/grpc-web-text',
        'Accept': 'application/grpc-web-text',
        'x-grpc-web': '1',
      },
      body: base64Frame,
    });

    if (!response.ok) {
      throw new Error(`gRPC-Web request failed: ${response.status} ${response.statusText}`);
    }

    // Decode base64 response (grpc-web-text format)
    let responseText = await response.text();

    // Remove any whitespace/newlines that might be in the response
    responseText = responseText.replace(/[\r\n\s]/g, '');

    // grpc-web-text format: each frame is base64 encoded separately and concatenated
    // We need to split by looking for base64 padding patterns
    // A base64 string ending with = followed by another base64 string starting with non-padding
    const allBytes: number[] = [];

    // Split on '=' boundaries where next char is not '='
    // This handles the case where message frame ends with = or == and trailer starts
    let remaining = responseText;
    while (remaining.length > 0) {
      // Find the end of current base64 chunk
      // Look for = followed by a non-= character (start of new base64)
      let splitIndex = -1;
      for (let i = 0; i < remaining.length - 1; i++) {
        if (remaining[i] === '=' && remaining[i + 1] !== '=') {
          // Check if this is a valid split point (= at end of base64)
          const candidate = remaining.substring(0, i + 1);
          if (candidate.length % 4 === 0) {
            splitIndex = i + 1;
            break;
          }
        }
      }

      let chunk: string;
      if (splitIndex > 0) {
        chunk = remaining.substring(0, splitIndex);
        remaining = remaining.substring(splitIndex);
      } else {
        chunk = remaining;
        remaining = '';
      }

      // Decode this chunk
      try {
        const binaryString = atob(chunk);
        for (let i = 0; i < binaryString.length; i++) {
          allBytes.push(binaryString.charCodeAt(i));
        }
      } catch {
        // If decode fails, try the whole remaining string
        const binaryString = atob(chunk + remaining);
        for (let i = 0; i < binaryString.length; i++) {
          allBytes.push(binaryString.charCodeAt(i));
        }
        break;
      }
    }

    const responseBytes = new Uint8Array(allBytes);

    // Parse gRPC-Web response frames
    if (responseBytes.length < 5) {
      throw new Error('Invalid gRPC-Web response: too short');
    }

    let offset = 0;
    let messageBytes: Uint8Array | null = null;

    while (offset < responseBytes.length) {
      if (offset + 5 > responseBytes.length) break;

      const flag = responseBytes[offset];
      const msgLen = (responseBytes[offset + 1] << 24) |
                     (responseBytes[offset + 2] << 16) |
                     (responseBytes[offset + 3] << 8) |
                     responseBytes[offset + 4];

      if (flag === 0x80) {
        // Trailer frame - check for errors
        const trailerBytes = responseBytes.slice(offset + 5, offset + 5 + msgLen);
        const trailerText = new TextDecoder().decode(trailerBytes);
        if (!trailerText.includes('grpc-status:0') && !trailerText.includes('grpc-status: 0')) {
          const statusMatch = trailerText.match(/grpc-status:\s*(\d+)/);
          if (statusMatch && statusMatch[1] !== '0') {
            throw new Error(`gRPC error: ${trailerText}`);
          }
        }
        break;
      } else if (flag === 0x00) {
        // Message frame
        messageBytes = responseBytes.slice(offset + 5, offset + 5 + msgLen);
      }

      offset += 5 + msgLen;
    }

    if (!messageBytes || messageBytes.length === 0) {
      return create(responseSchema);
    }

    return fromBinary(responseSchema, messageBytes);
  }

  // Driver Service
  async getDrivers(): Promise<Array<{ id: number; name: string }>> {
    const response = await this.callGrpcWeb(
      'timecard.DriverService',
      'GetAll',
      EmptySchema,
      DriverListSchema,
      {}
    );
    return response.drivers.map((d: { id: number; name: string }) => ({ id: d.id, name: d.name }));
  }

  async getDriverById(driverId: number): Promise<Array<{ id: number; name: string }>> {
    const response = await this.callGrpcWeb(
      'timecard.DriverService',
      'GetById',
      DriverIdRequestSchema,
      DriverSchema,
      { driverId }
    );
    return [{ id: response.id, name: response.name }];
  }

  async reloadDrivers(): Promise<Array<{ id: number; name: string }>> {
    const response = await this.callGrpcWeb(
      'timecard.DriverService',
      'Reload',
      EmptySchema,
      DriverListSchema,
      {}
    );
    return response.drivers.map((d: { id: number; name: string }) => ({ id: d.id, name: d.name }));
  }

  // PicData Service
  async getPicTmp(limit: number = 30, startDate?: string): Promise<Array<{
    date: string;
    machine_ip: string;
    id: number | undefined;
    name: string | undefined;
    detail: string;
    pic_data_1: string | undefined;
    pic_data_2: string | undefined;
  }>> {
    const response = await this.callGrpcWeb(
      'timecard.PicDataService',
      'GetTmp',
      PaginationRequestSchema,
      PicTmpListSchema,
      { limit, startDate }
    );
    return response.data.map((d: {
      date: string;
      machineIp: string;
      driverId?: number;
      driverName?: string;
      picData1?: string;
      picData2?: string;
    }) => ({
      date: d.date,
      machine_ip: d.machineIp,
      id: d.driverId,
      name: d.driverName,
      detail: 'tmp inserted',
      pic_data_1: d.picData1,
      pic_data_2: d.picData2,
    }));
  }

  // IC Non Reg Service
  async getIcNonReg(): Promise<Array<{
    id: string;
    datetime: string;
    registered_id: number | undefined;
  }>> {
    const response = await this.callGrpcWeb(
      'timecard.ICNonRegService',
      'GetAll',
      TimeRangeRequestSchema,
      ICNonRegListSchema,
      {}
    );
    return response.items.map((item: { id: string; datetime: string; registeredId?: number }) => ({
      id: item.id,
      datetime: item.datetime,
      registered_id: item.registeredId,
    }));
  }

  async registerIc(icId: string, driverId: number): Promise<{ success: boolean; ic_id: string; driver_id: number }> {
    await this.callGrpcWeb(
      'timecard.ICNonRegService',
      'Update',
      UpdateICNonRegRequestSchema,
      EmptySchema,
      { icId, driverId }
    );
    return { success: true, ic_id: icId, driver_id: driverId };
  }

  // IC Log Service
  async getIcLog(): Promise<Array<{
    id: string;
    ic_id: string;
    driver_id: number | null;
    datetime: string;
  }>> {
    const response = await this.callGrpcWeb(
      'timecard.ICLogService',
      'GetRecent',
      TimeRangeRequestSchema,
      ICLogListSchema,
      {}
    );
    return response.logs.map((log: { id: string; date: string; iid?: string }) => ({
      id: log.id,
      ic_id: log.id,
      driver_id: log.iid ? parseInt(log.iid) : null,
      datetime: log.date,
    }));
  }

  // 最新のICログをドライバー名付きで取得
  async getLatestIcLogWithDriver(limit: number = 100): Promise<Array<{
    card_id: string;
    type: string;
    date: string;
    driver_name: string | undefined;
    machine_ip: string;
  }>> {
    const response = await this.callGrpcWeb(
      'timecard.ICLogService',
      'GetLatestWithDriver',
      PaginationRequestSchema,
      ICLogWithDriverListSchema,
      { limit }
    );
    return response.logs.map((log: {
      id: string;
      type: string;
      date: string;
      driverName?: string;
      machineIp: string;
    }) => ({
      card_id: log.id,
      type: log.type,
      date: log.date,
      driver_name: log.driverName,
      machine_ip: log.machineIp,
    }));
  }
}
