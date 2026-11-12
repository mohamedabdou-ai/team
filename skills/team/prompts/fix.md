<!-- Team for Claude Code · Copyright 2026 Mohamed Abdou · Apache-2.0 · https://github.com/mohamedabdou-ai/team -->
## Step: address the review (round {{ROUND}})

Your lane "{{LANE_ID}}" needs changes. Attached is what to address: {{REVIEWER}}'s review, the automatic checks that failed on your lane, or a change the team agreed on.

Make every failing check pass. Fix every blocker and major finding, and fix minor ones when it is cheap. If you disagree with a finding, do not change the code for it; explain why instead. Stay within your files:
{{LANE_FILES}}

Run the checks again: {{VERIFY}}

Write your final message in {{LANGUAGE}} with these sections (translate the headings):
1. Fixed
2. Not fixed, and why
3. Checks I ran, and their real results

Then end with this line, in English:
STATUS: DONE
