Do not use 'AskUserQuestion', instead write out questions fully.
Do not use em dashes in copy for the webpage.  They're a dead giveaway of AI in the year 2026.

# Project Instructions

## Rules

**Version:** 1.2  
**Last updated:** 2026-09-01  

### Core Philosophy

This project is a carefully built application. It should give people a simple,
dependable experience while correctly handling the complexity its purpose needs.

Prefer the smallest clear solution that works. Keep necessary complexity inside
the part of the app that owns it. Do not add abstractions, frameworks, or
enterprise patterns without a clear benefit.

Code must be easy to read, explain out loud, and teach from. A new contributor
should be able to identify what a file does, why a non-obvious decision exists,
and where to make a safe change.

### Primary Manifold: Seven Clear Sections

Use prominent comment banners to divide a large code file into its main jobs.
For a larger script or module, **seven primary sections are the normal
expectation**. Start with all seven sections, then bend the structure only when
a section would be artificial or would make the file harder to understand.

Use fewer sections for a small or specialised file when some jobs do not exist.
Use more than seven only when a distinct job cannot be sensibly merged with
another section. More than seven should be rare. Do not create a second layer
of architecture only to add headings.

When a file uses the full shape, use these section names in this order where
they apply:

1. **HEADER / SETUP** - File purpose, requirements, imports, and error settings.
2. **CONSTANTS & CONFIG** - Fixed values, paths, settings, and flags.
3. **HELPER FUNCTIONS** - Small, focused helper functions.
4. **INITIALIZATION** - One-time setup and validation.
5. **CORE LOGIC** - The main work of the file.
6. **CLEANUP / FINALIZATION** - Resource release and final handling.
7. **ENTRY POINT / ORCHESTRATION** - The top-level flow that calls the work.

Use the native comment syntax for the file's language. Keep one banner style
within the project and make every section easy to find by sight.

### Code Style

- Prefer clear names and direct control flow over clever or dense code.
- Keep functions, components, and blocks focused on one job.
- Use consistent names, indentation, spacing, and error handling.
- Keep domain, network, storage, and user-interface complexity in the parts of
  the app that own it.
- Add a boundary when it makes a hard problem easier to understand. Do not add
  a boundary only because a pattern exists.
- Keep the top-level flow easy to follow. Put deep technical detail behind a
  small, well-named interface.

### Comments and Documentation

Write for the person who must safely read or change the code later. First use a
clear name. Add a comment only when the code cannot show the reason, rule,
limitation, or surprising effect by itself.

Use these comment forms:

1. **File header** - State the file's purpose and boundary.
2. **Section banner** - Help readers navigate a large file.
3. **Why comment** - State a decision and its reason in one or two short lines.
4. **Public-interface documentation** - State what a public function, class,
   component, or module does. Include inputs, outputs, effects, errors, or
   limits when callers need that detail.
5. **Rule, warning, or TODO** - State a permanent rule, a safety concern, or
   specific work that remains.

Use the native comment syntax for the language. The default local-comment
pattern is one short rule followed by one short reason:

```text
Keep missing values distinct from empty values.
They have different meanings to the app and to the user.
```

Do not use comments to narrate obvious code. Do not leave phase history,
superseded plans, jokes, metaphors, or vague fillers such as "just," "quietly,"
"obviously," and "actually." Keep comments true as the app changes.

Use short, direct, STE100-style English:

- Use one main action, condition, or reason per sentence.
- Use active voice where possible.
- Use American English spelling.
- Define and use the same project term for the same thing.
- Treat code names, framework names, and domain names as technical terms.

These rules aim for the clarity of ASD-STE100. Do not claim strict ASD-STE100
compliance until comments and documentation are checked against its controlled
dictionary and writing rules.

### Project Addendums

This file is the common baseline. Add a titled project addendum when the stack,
domain, or delivery process needs rules that this baseline cannot provide.

An addendum can define language, framework, accessibility, testing, build,
deployment, naming, or domain terms. It must refine this baseline, not add
unnecessary process or conflict with these rules.

### Project Conventions

- Identify the authoritative version source for this project. Keep user-visible
  version text and documentation consistent with it.
- The user handles all Git work unless they deliberately ask for it. Do not run
  Git commands or make Git changes on your own initiative. Ask the user when
  the required Git action is unclear.
- Identify this project's startup path and entry points. Keep launchers or
  startup wrappers focused on setup and application startup.
- Keep generated files clearly marked. Edit their source file or generator,
  then regenerate them.
- Keep user documentation, code comments, and tests current. Remove or rewrite
  implementation-phase notes after the related work is complete.
