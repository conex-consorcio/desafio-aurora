---
description: Records in AI-LOG.md at the project root what was asked to the AI and the result obtained. Use after finishing a coding task or session.
agent: build
---

# /log-ia

Record in the project's `AI-LOG.md` what was requested from the AI and the result obtained. Use this at the end of a task or session to keep an honest log of AI-assisted work.

## Steps

1. **Resolve the project root**: run `git rev-parse --show-toplevel`; if that fails, use the current working directory. `AI-LOG.md` lives at the project root.

2. **Read the existing `AI-LOG.md`**, if it exists, to match its format and language. If it does not exist, create it with:

   ```markdown
   # AI-LOG

   Log of how this project was driven with the help of an AI.
   ```

3. **Append a new section at the end** following the existing file's style:

   ```markdown
   ## Session — <YYYY-MM-DD> — <short title>

   ### Request
   <what was asked, faithful to the user's words>

   ### Result
   <what was achieved: files touched, commands run, tests green/red, decisions, what is still pending>
   ```

   - `$ARGUMENTS` may carry a title or an extra note; use it if helpful.
   - Keep the section short and honest: what was requested, what was done, what was **not** done.
   - Never log PII (CPF, CNPJ, email, phone).
   - Never invent results: record only what actually happened in the session.

4. Confirm to the user: `AI-LOG.md updated` and where the new section was added.