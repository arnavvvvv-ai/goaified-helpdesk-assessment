# HR and IT helpdesk

A local prototype for GoAified’s internship assessment. It answers questions from eight fictional HR and IT policies and looks up annual leave for a fixed demo employee. It runs without API keys.

## Run locally

Use Node.js 20 or later and npm.

```sh
npm ci
npm test
npm start
```

Enter one question per line. Type `exit` to quit.

## Demo

[Download the terminal walkthrough](./GoAified_Helpdesk_Demo.mp4?raw=true). It shows a run of the CLI using fictional data.

| Try asking | Expected result |
| --- | --- |
| How many days in advance should I request annual leave? | Five working days, cited to annual leave policy HR-01. |
| How do I connect to the VPN? | Use the approved VPN client. If it fails, check internet access and contact IT with the error code (IT-03). |
| How many leave days does E102 have left? | Eight days from the demo leave register. |
| How many leave days does E103 have left? | The helpdesk declines the request. |
| What does the sabbatical policy allow? | The helpdesk finds no approved answer and refers the question to HR or IT. |

## How it works

The CLI starts an MCP server over stdio. The server seeds an embedded PostgreSQL database using PGlite and enables pgvector. It exposes two tools:

- `search_policy` uses hashed tokens and cosine similarity to rank policy passages. It returns the stored passage and source ID when the match clears a relevance threshold and shares a term with the policy title. The prototype uses extractive retrieval without a language model.
- `get_my_leave_balance` reads one row for synthetic employee `E102` using a parameterized query. The tool takes no arguments. Policy questions about notice periods or documentation go to the policy tool.

## Limitations

The demo identity is fixed in code. The CLI uses simple rules for off-topic requests, instruction overrides, and requests for personal information. The policy tool returns only seeded text, and the output filter covers common email and phone patterns. A production deployment would need verified user identity, server-side authorization, and retrieval evaluation against a larger set of paraphrased and ambiguous questions.
