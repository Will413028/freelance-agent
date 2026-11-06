---
description: Job feed collection and ingest
paths:
  - "backend/src/freelance/modules/collection/**"
  - "web/src/modules/collection/**"
---

# Collection sources

- Fix only confirmed, exact format defects in a public feed; isolate a single item missing its title or URL and mark it partial; zero matches does not mean the source failed.
