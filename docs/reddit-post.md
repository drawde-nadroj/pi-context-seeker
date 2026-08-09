# I made a Pi package for asking users questions instead of guessing

I extracted a question UI I use with Pi into a standalone package: **pi-ask-user-question**.

It adds two tools: `ask_user_question` for one free-form or choice question, and `ask_questions` for a related batch in a tabbed review flow. It supports recommended options, custom answers, multi-select, optional notes, and an inline way to ask the agent for clarification before answering.

Install from Git:

```bash
pi install git:https://github.com/the-sleeping-teemo/pi-ask-user-question
```

Repository: https://github.com/the-sleeping-teemo/pi-ask-user-question

I would especially value feedback on terminal compatibility, keyboard flow, structured tool results, and cases where the agent chooses the wrong question mode. Issues and contributions are welcome—including help making an accurate short demo.
