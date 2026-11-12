# Team for Claude Code

**Claude and Codex work as one team on your code.** They each propose a design, argue it out with evidence from the code, agree on a plan, build their parts in parallel, and review each other's work. You approve the design once and get a report at the end.

By [Mohamed Abdou (محمد عبده)](https://store.pyraai.cloud). Not affiliated with Anthropic or OpenAI.

## How a run goes

1. **You ask:** `/team add tag filtering to the notes page`. Arabic works too.
2. **It sizes the task:**
   - **Small** (a bug fix, a tweak): goes straight to work. Codex builds it and Claude reviews it.
   - **Medium:** one round of independent proposals, then a joint design.
   - **Large** (architecture, migrations, auth, payments): a full debate. They propose, critique each other, write a joint design and sign off on it.
3. **You approve the design once.** Anything they still disagree on is shown to you with both positions.
4. **They build in parallel.** Each agent works in its own git worktree and branch, so neither can break the other's work.
5. **Checks run on their own.** The project's tests, lint and build run after every build step, and a failure goes back to the agent that built that part.
6. **They review each other with evidence.** Every finding must quote the code or a command they ran, and an approval must show attempts to break the code. The script checks both before it accepts a review.
7. **The parts are merged and verified.** Each part becomes one squash commit, so `git revert` undoes it cleanly. You get a report in your language.

If one agent hits a usage limit, crashes or hangs, the other covers its job. Everything is saved under `.team/runs/`, so `/team resume` continues an interrupted run.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- [Codex CLI](https://github.com/openai/codex), logged in (`codex login`)
- Node.js 18 or newer
- git

Without Codex, Claude covers every Codex job (and the other way round), but you lose the second opinion.

## Install

In Claude Code:

```
/plugin marketplace add mohamedabdou-ai/carousel-studio
/plugin install team@mohamed-abdou
```

Manual install on Windows: clone the repo and run `install.ps1`.

## Use

```
/team <what to build or change>
/team resume
```

To watch the discussion live in your browser, ask for it during a run ("show me the team live").

## Settings

You set these as environment variables. They can also go in `skills/team/config.json`.

| Variable | Default | Meaning |
|---|---|---|
| `TEAM_CODEX_MODEL` / `TEAM_CLAUDE_MODEL` | the tool's own default | model for each colleague |
| `TEAM_CODEX_EFFORT` / `TEAM_CLAUDE_EFFORT` | `high` / default | reasoning effort |
| `TEAM_CODEX_LITE` | `1` | run Codex without plugins, apps, memories and browser tools; image generation stays on |
| `TEAM_STALL_MINUTES` | `15` | minutes without output before a colleague counts as hung |
| `TEAM_CODEX_BIN` / `TEAM_CLAUDE_BIN` | auto-detected | path to each CLI |

## Status

Tested on Windows 11 with Claude Code 2.1 and Codex CLI 0.163. macOS and Linux should work, but they are not tested yet. Bug reports are welcome.

## License and credit

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

You may use, change and redistribute this work, including commercially. If you redistribute it or build on it, keep the `NOTICE` file and the copyright lines, and credit it as **"Based on Team for Claude Code by Mohamed Abdou"**.

---

## بالعربي

سكيل بتخلّي كلود وCodex يشتغلوا كفريق واحد على مشروعك:

- كل واحد فيهم يقترح تصميم، ويتناقشوا بالدليل من الكود، ويتفقوا على خطة.
- انت بتوافق على التصميم مرة واحدة.
- كل واحد يبني جزء منفصل في نفس الوقت، والاختبارات تشتغل لوحدها.
- كل واحد يراجع شغل التاني، وفي الآخر بيوصلك تقرير بلغتك.

اكتب `/team` وبعدها الطلب بتاعك.
