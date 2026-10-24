import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { AddressInfo } from "node:net";
import { SQL } from "bun";
import { AppModule } from "../../src/app.module.ts";
import { configureApp } from "../../src/app.setup.ts";
import { loadConfig } from "../../src/config.ts";
import { prepareTestDatabase } from "./database.ts";

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  sql: SQL;
  request(method: string, path: string, options?: { body?: unknown; headers?: Record<string, string> }): Promise<TestResponse>;
  close(): Promise<void>;
}

export interface TestResponse {
  status: number;
  headers: Headers;
  body: any;
}

export async function startTestApp(): Promise<TestApp> {
  const databaseUrl = await prepareTestDatabase();
  const config = { ...loadConfig(), NODE_ENV: "test" as const, DATABASE_URL: databaseUrl, DATABASE_POOL_MAX: 20 };
  const app = await NestFactory.create(AppModule.forRoot(config), { logger: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const sql = new SQL(databaseUrl);

  return {
    app,
    baseUrl,
    sql,
    async request(method, path, options = {}) {
      const headers: Record<string, string> = { ...options.headers };
      let body: string | undefined;
      if (options.body !== undefined) {
        headers["content-type"] ??= "application/json";
        body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      }
      const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
    },
    async close() {
      await sql.close();
      await app.close();
    },
  };
}
