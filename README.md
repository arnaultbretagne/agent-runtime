# agent-runtime

Brique **infra** : une image générique + un **superviseur thin** qui instancie et gère des
**sessions de runtime agent** (Claude Code en premier) dans un pod Kubernetes. Chaque session
fait tourner un agent interactif sur son abonnement, relié à l'extérieur par un **channel**
(un serveur MCP stdio que l'agent spawn lui-même).

Ce repo est **agnostique au produit** : il sait *faire tourner des agents*, rien sur les
conversations, l'UI, ou un channel/website précis. Le produit (channel + website) vit dans son
propre repo et se branche dessus.

Décisions de design : voir [`docs/adr/`](docs/adr/).
