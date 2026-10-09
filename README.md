# hi.Daisy

hi.Daisy is a Cloudflare-based support operations platform that connects a web portal, Slack, Salesforce, and Cloudflare D1.

It was built to demonstrate how I approach technical support operations: reducing manual work, improving visibility, connecting systems through APIs, and building tools that make support teams more effective.

## What It Does

- Creates and manages support requests
- Posts and updates Slack messages
- Tracks request status and ownership
- Connects related Salesforce data
- Supports role-based access
- Includes restricted Guest/demo access
- Uses OAuth-based authentication
- Provides operational logging and health checks

## Tech Stack

- Cloudflare Workers
- Cloudflare D1
- JavaScript
- SQL
- HTML/CSS
- Slack API
- Salesforce API
- Google OAuth
- Okta

## Live Demo

https://daisy.smithbits.io/login

Guest access is available so the application can be explored without making persistent changes.

## Architecture

The application is split across multiple Cloudflare Workers, with each Worker responsible for a specific part of the system.

See `ARCHITECTURE.md` for a high-level view of the system design and request flows.

## API

See `API.md` for a high-level overview of the application endpoints and how the services communicate.

## Database

A sanitized database schema is included in `schema.sql`.

## About This Repository

This repository is a sanitized demonstration version of the project.

Credentials, production data, environment-specific configuration, and selected infrastructure details have intentionally been excluded.

### AI-Assisted Development

hi.Daisy was developed with assistance from ChatGPT, Copilot, and Claude.

AI was used to accelerate coding, explore solutions, and troubleshoot issues. I directed the development, designed the architecture, questioned assumptions, challenged recommendations, and made the final decisions. AI-generated code was reviewed, tested, and validated rather than accepted at face value.
