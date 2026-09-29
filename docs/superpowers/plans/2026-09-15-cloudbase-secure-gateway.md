# CloudBase Secure Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the CoolZou mini program to the existing Lighthouse backend through the CloudBase service without a privately owned domain.

**Architecture:** A small streaming gateway runs in CloudBase and forwards approved paths to the existing backend over verified TLS. JSON uses `wx.cloud.callContainer`; protected binary files use the CloudBase public HTTPS endpoint.

**Tech Stack:** Node.js 24, built-in HTTP/HTTPS, WeChat Mini Program APIs, Docker Compose, nginx.

**Spec:** `docs/superpowers/specs/2026-09-15-cloudbase-secure-gateway-design.md`

## Global Constraints

- Do not store real secrets or private keys in source files.
- Keep local demo mode working.
- Do not migrate SQLite or generated files in this phase.
- Production gateway-to-server traffic must use verified HTTPS.

---

### Task 1: Streaming CloudBase gateway

**Files:**
- Create: `cloud-gateway/server.mjs`
- Create: `cloud-gateway/package.json`
- Create: `cloud-gateway/Dockerfile`
- Test: `tests/cloud-gateway.test.mjs`

**Interfaces:**
- Consumes: `UPSTREAM_ORIGIN`, `UPSTREAM_CA_B64`, `GATEWAY_SECRET`, `PORT`
- Produces: `createGateway(options)` and HTTP routes `/health`, `/api/*`, `/download/*`

- [x] Write a failing integration test covering forwarding, secret override, origin stripping, status and body.
- [x] Run the test and confirm failure because `cloud-gateway/server.mjs` is absent.
- [x] Implement the minimum streaming proxy with Node standard libraries.
- [x] Run the test and confirm pass.

### Task 2: Protect the existing backend

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/main.mjs`
- Test: `tests/api.test.mjs`

**Interfaces:**
- Consumes: `GATEWAY_SECRET`, `HOST`, `PORT`
- Produces: constant-time gateway header validation for `/api/*` and `/download/*`

- [x] Write a failing API test for missing, wrong and correct gateway secrets.
- [x] Run the test and confirm the protected request currently succeeds.
- [x] Add minimal conditional protection and configurable bind host.
- [x] Run the test and confirm pass.

### Task 3: CloudBase mini-program transport

**Files:**
- Modify: `miniprogram/app.js`
- Modify: `miniprogram/utils/api.js`
- Test: `tests/miniprogram-cloud.test.mjs`

**Interfaces:**
- Consumes: public environment ID, service name and CloudBase public URL.
- Produces: JSON requests through `callContainer`, authenticated binary downloads through the public URL, local-mode fallback.

- [x] Write failing VM tests for cloud requests, errors and binary URL selection.
- [x] Run the tests and confirm current `wx.request` behavior fails expectations.
- [x] Implement the minimum transport switch and photo temporary-file hydration.
- [x] Run the tests and confirm pass.

### Task 4: Lighthouse deployment

**Files:**
- Create: `Dockerfile`
- Create: `deploy/compose.yaml`
- Create: `deploy/nginx.conf`
- Create: `deploy/create-ip-certificate.sh`
- Create: `.env.production.example`
- Create: `cloud-gateway/.env.example`

**Interfaces:**
- Consumes: server environment variables and generated TLS files.
- Produces: persistent app container on loopback plus nginx TLS endpoint on port 8443.

- [ ] Add Docker and TLS files without real secrets.
- [ ] Validate Compose rendering and shell syntax.

### Task 5: Full verification

**Files:**
- Modify: planning progress files only.

- [ ] Run targeted tests.
- [ ] Run `npm test`.
- [ ] Scan tracked project files for secret-like values.
- [ ] Record remaining deployment-only steps.
