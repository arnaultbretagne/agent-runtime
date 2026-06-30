# agent-runtime

**Infra** brick: a generic image + a **thin supervisor** that instantiates and manages **agent
runtime sessions** (Claude Code first) inside a Kubernetes pod. Each session runs an interactive
agent on its subscription, connected to the outside through a **channel** (a stdio MCP server the
agent spawns itself).

This repo is **product-agnostic**: it knows how to *run agents*, nothing about conversations, the
UI, or any specific channel/website. The product (channel + website) lives in its own repo and
plugs into this one.

Design decisions: see [`docs/adr/`](docs/adr/).
