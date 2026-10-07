# API Overview

This document provides a high-level reference for the main hi.Daisy application endpoints.

Environment-specific hostnames, credentials, secret values, and selected internal routes are intentionally excluded.

## New Requests

### `POST /api/v1/new`

Creates a new support request.

Primary caller:
- Salesforce

Fallback caller:
- Compose in the web portal

Main actions:
- Validates the incoming request
- Creates the Slack message
- Stores the request in D1
- Updates Salesforce when applicable

Authentication:
- Internal API authentication for system-to-system requests
- Portal session authentication for Compose submissions

---

## Slack Actions

### `POST /api/v1/dispatcher`

Receives Slack interactive events.

Main actions:
- Validates the Slack request signature
- Identifies the requested action
- Routes the action to downstream processing

Authentication:
- Slack request signing validation

---

## Messages

### `POST /api/v1/messages`

Finds an existing Slack support message and its related application data.

Primary caller:
- Web portal

Authentication:
- Portal session authentication

### `PATCH /api/v1/messages`

Updates an existing Slack support message and related application data.

Primary caller:
- Web portal

Authentication:
- Portal session authentication

---

## Dashboard

### `PATCH /api/v1/save/dashboard`

Updates a dashboard record.

Primary caller:
- Web portal

Authentication:
- Portal session authentication
- Role-based authorization

### `DELETE /api/v1/save/dashboard`

Deletes a dashboard record.

Primary caller:
- Web portal

Authentication:
- Portal session authentication
- Role-based authorization

---

## Help

### `POST /api/v1/save/help`

Creates a help item.

### `PATCH /api/v1/save/help`

Updates a help item.

### `DELETE /api/v1/save/help`

Deletes a help item.

Primary caller:
- Web portal

Authentication:
- Portal session authentication
- Role-based authorization

---

## Health Check

### `POST /api/v1/health-check`

Runs application and integration health checks.

Authentication:
- Internal API authentication

---

## Worker Health Endpoints

Some Workers also expose:

`GET /health`

These endpoints provide a basic availability check for the individual Worker.

---

## Authentication Routes

hi.Daisy uses dedicated authentication and callback routes for:

- Google OAuth
- Okta
- Salesforce OAuth

Exact URLs and environment-specific configuration are intentionally excluded from this document.

---

## Repository Scope

This API reference is intentionally limited to the main application interfaces needed to understand how hi.Daisy moves data between Salesforce, Slack, the web portal, and Cloudflare D1.

Administrative, credential-management, and selected internal endpoints are intentionally excluded.
