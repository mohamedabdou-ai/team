<!-- Team for Claude Code · Copyright 2026 Mohamed Abdou · Apache-2.0 · https://github.com/mohamedabdou-ai/team -->
## Step: implement your lane

Lane "{{LANE_ID}}": {{LANE_TITLE}}

Your tasks:
{{LANE_TASKS}}

Files you own (create or edit only these):
{{LANE_FILES}}

{{OTHER_LANES}}

{{ESCALATE_RULE}}

The specification is attached. Follow it. If something in it turns out to be wrong or impossible, do the soundest thing that stays within your files and report it as a design issue (below) instead of quietly changing the design.

If your part needs a new image (an icon, illustration, photo, or background): generate it yourself if you have an image generation tool and save it inside your lane. If you do not have one, do not draw a placeholder; add one line per image to your final message, `IMAGE_REQUEST: <file path inside your lane> | <what it shows, size, style>`, and Codex will generate it into your lane.

When you are done, run these checks where they apply: {{VERIFY}}
(The coordinator also runs them automatically on your lane before review; failures come back to you to fix.)

Write your final message in {{LANGUAGE}} with these sections (translate the headings):
1. What I built
2. Files changed
3. Checks I ran, and their real results
4. Notes for the reviewer

Then end with these two lines, in English:
DESIGN_ISSUE: none
STATUS: DONE

Replace "none" with a one-line description of the problem and your proposed change if you found a design issue. Write `STATUS: PARTIAL - <reason>` if you could not finish.
