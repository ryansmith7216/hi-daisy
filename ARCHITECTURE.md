# Architecture

## System Overview

hi.Daisy is built on Cloudflare Workers with Cloudflare D1 as the shared database.

It connects three main surfaces:

```text
Salesforce
    |
    v
Cloudflare Workers
    |
    +----> D1
    |
    +----> Slack
    |
    +----> Web Portal
```

Salesforce is the primary source for new support requests.

Slack is used for request handling and interactive actions.

The web portal provides visibility, management, fallback submission, and administrative access.

---

## Worker Responsibilities

### Pages

Serves the web portal and handles browser-side application logic.

### New

Receives new support requests, primarily from Salesforce.

It creates the Slack request and stores the application record.

Compose uses this same path as a manual fallback.

### Dispatcher

Receives Slack interactive actions and determines which backend operation should handle them.

### Downstream

Handles actions taken after a request has been created, including Slack updates, status changes, and Salesforce-related actions.

### Messages

Finds and updates existing Slack message data.

### Save

Handles application data updates from the portal.

### Clean

Handles cleanup operations.

### Slack User Sync

Checks applicable portal users against Slack and updates their portal status when needed.

### Authentication Workers

Separate Workers handle authentication and callback flows for:

- Google
- Okta
- Salesforce

### Health Check

Checks application and integration health.

---

## Main Request Flows

### New Request

```text
Salesforce
    |
    v
New Worker
    |
    +----> D1
    |
    +----> Slack
```

Manual fallback:

```text
Compose
   |
   v
Pages
   |
   v
New Worker
   |
   +----> D1
   |
   +----> Slack
```

### Slack Action

```text
Slack
   |
   v
Dispatcher
   |
   v
Downstream
   |
   +----> D1
   +----> Slack
   +----> Salesforce
```

### Portal Update

```text
Web Portal
    |
    v
Pages
    |
    v
Backend Worker
    |
    +----> D1
    |
    +----> External API when needed
```

### Authentication

```text
Identity Provider
       |
       v
Callback Worker
       |
       v
Portal Session
```

---

## Data and Integrations

### Cloudflare D1

D1 stores the application data used by the Workers. Historical event data and metrics are saved in Salesforce.

The database schema includes:

- Dashboard
- User
- Settings
- Error
- Help

A sanitized schema is included in `schema.sql`.

### Slack

Slack is the primary workspace where support requests are posted and worked.

hi.Daisy uses the Slack API to:

- Create request messages
- Update existing request messages
- Receive interactive button actions
- Relay request information between channels when needed

### Salesforce

Salesforce is the primary source for new support requests.

hi.Daisy uses Salesforce to:

- Send new request data into the application
- Store Salesforce case references with the request
- Update Salesforce when certain downstream actions require it
- Maintain API access through Salesforce OAuth

---

## Repository Scope

This repository is a sanitized demonstration version of hi.Daisy.

It includes the application structure, Worker logic, integrations, and data model while excluding production data, credentials, secret values, and selected environment-specific configuration.
