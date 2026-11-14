[duty -> {{key}}] Waiting on {{target}} since {{waitingSince}}; no new evidence for {{age}}.
Waiting does not stop this clock; 40 minutes without progress goes to the lead with what you wait on.
- Check that {{target}} is still alive and moving (a check, a process, a request).
- It moved: `{{dori}} report {{key}} --text '<what changed>' --evidence <its log, file or link>`
- It is done: `{{dori}} report {{key}} --status working --text '<result>' --evidence <file|link>`
- It is stuck: `{{dori}} report {{key}} --status waiting --text 'STUCK: <what you saw>'`, then work around it.
