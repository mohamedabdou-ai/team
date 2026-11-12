<!-- Team for Claude Code · Copyright 2026 Mohamed Abdou · Apache-2.0 · https://github.com/mohamedabdou-ai/team -->
## Step: independent proposal

The owner's request:
<request>
{{REQUEST}}
</request>

Study the relevant code first. Then write YOUR OWN proposal for how the team should do this. {{TEAMMATE}} is writing theirs at the same time without seeing yours, and afterwards you will compare and debate, so think independently and commit to a position.

Use these sections (translate the headings into {{LANGUAGE}}):
1. Understanding: what the owner wants, in 2-4 sentences, and the assumptions you made.
2. Current state: the relevant facts in the codebase, with file paths.
3. Proposed design: components and their responsibilities, data and model changes, interfaces (APIs, functions, events), the user-facing flow, and how the pieces connect.
4. Alternatives considered. Compare your design against three baselines, and say in writing why yours beats each: (a) doing nothing or the smallest possible change, (b) the biggest correct change, (c) the tempting shortcut. Add any other real alternative you weighed.
5. Risks and edge cases, and how the design handles each one.
6. Work split: up to two lanes that can be built in parallel without sharing any file (list the files each lane owns and the interface between them), or explain why the work should not be split.
7. Questions for {{TEAMMATE}}: up to 3 specific points you want them to weigh in on.

If the request mixes problems that have nothing to do with each other, say so and end with a line `SPLIT: <how you would split it into separate requests>`.
