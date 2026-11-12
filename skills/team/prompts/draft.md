<!-- Team for Claude Code · Copyright 2026 Mohamed Abdou · Apache-2.0 · https://github.com/mohamedabdou-ai/team -->
## Step: write the joint design

You and {{TEAMMATE}} each proposed a design independently; if there was a debate round, your responses to each other are attached as well. Write the single joint design document the team will present to the owner.

Rules:
- Reflect what the two of you agree on, including the points one of you adopted from the other. Where the proposals differ and no response settled it, choose the option both proposals' reasoning supports best; when that is unclear, it is a decision for the owner.
- Where you still disagree, do not pick a winner. Put the point under "Decisions for the owner" with both positions stated fairly, their pros and cons, and a joint recommendation only if both of you would accept it.
- The work plan must be buildable in parallel: at most two lanes, one per agent ("claude" and "codex"), and no file owned by both lanes. Give each agent the lane that fits its lens. Fix the interface between the lanes (function signatures, API shapes, data formats) in the design so both can build against it at the same time. If the work should not be split, use a single lane.
- Codex can generate images and Claude cannot. If the work needs new images (icons, illustrations, photos, backgrounds), put creating them in Codex's lane.
- Be specific enough that each lane can be implemented without asking anything.
- Your final message must be the document itself, starting with the `# ` title line. No preface and no closing remarks.

Write the document in {{LANGUAGE}} with this structure (translate the headings):

# <short title>
## 1. Goal
## 2. Options considered, and why we chose this one
(always including: doing nothing or the smallest change, the biggest correct change, and the tempting shortcut, with why the chosen design beats each)
## 3. System design
(components and responsibilities; data and state; interfaces such as APIs, functions, and events; the end-to-end flow)
## 4. Risks and how we handle them
## 5. Work plan
(for each lane: the owning agent, its tasks in order, and the files it owns; the interface between the lanes)
## 6. Definition of done
(acceptance checks, and the exact commands that verify them)
## 7. Decisions for the owner
(for each unresolved point: the question, Claude's position, Codex's position, pros and cons, and a joint recommendation if there is one; or one line saying there are none)
## 8. Machine plan
End the document with this fenced block, filled in. Keep the keys in English; values may be in {{LANGUAGE}}. Lane ids use English letters, digits, and dashes. Paths are relative to the project root, and globs such as src/api/** are allowed. "setup" installs dependencies in a fresh checkout (empty if nothing is needed); "verify" lists commands that must pass when the work is done.

```json team-plan
{
  "setup": [],
  "verify": ["npm test"],
  "lanes": [
    {"id": "backend", "agent": "codex", "title": "...", "tasks": ["...", "..."], "files": ["src/api/**", "test/api.test.js"]},
    {"id": "frontend", "agent": "claude", "title": "...", "tasks": ["...", "..."], "files": ["public/**"]}
  ],
  "merge_order": ["backend", "frontend"]
}
```

The owner's request:
<request>
{{REQUEST}}
</request>
