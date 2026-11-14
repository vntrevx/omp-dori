[duty -> {{key}}] No new evidence since {{since}} ({{age}}), quiet for {{minutes}} minutes, no READY yet.
A report without new evidence does not reset this clock; 40 minutes without progress goes to the lead.
- Done: `{{dori}} ready {{key}} --text '<final answer>' --evidence <link>`
- Progress: `{{dori}} report {{key}} --text '<milestone>' --evidence <changed file | new PR link>`
- Blocked outside this pane: `{{dori}} report {{key}} --status waiting --text 'WAITING: <blocker>'`
- Otherwise continue the work now.
