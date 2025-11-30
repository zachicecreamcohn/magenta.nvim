I want to implement a parsing-based permissions structure for which bash commands can execute.

Use the technique described in this blog post: https://engineering.desmos.com/articles/pratt-parser/

here's sample code that should serve as a starter point: https://github.com/desmosinc/pratt-parser-blog-code

During lexing, let's use a modal / stack-based lexer. We have a mode (expression, string, comment, interpolation). Consuming characters from the string produces tokens and can switch us into a new mode (push the mode) or out of the mode (pop the mode). Make sure we support strings and things like shell expansion.

During parsing, we don't need to understand the full bash command. We mostly need to understand the following:

- how the command decomposes into sub-commands (&&, ||, pipes, semicolons)
- common console redirections, like 2>&1
- for each command, what was the invoked script and the list of arguments provided

The point of this is to support a more advanced options for automatically allowed bash commands. I want this to be safe and predictable from the user's pov - to make it easy to understand exactly what will be allowed to run, and to stay on the safe side to make sure no hacky workarounds to execute arbitrary commands, or allow access to unexpected files.

We will not handle more advanced bash features, like command expansions and such. If we encounter an unusual or unexpected pattern, we should just bail and not allow the command to run (and fall back to asking the user for permission to run it).

The options are currently specified in `node/options.ts`, in the `commandAllowlist` option. I want to replace this with the following structure:

```
{
    npx: {
        subCommands: {
            tsc: {
                arguments: [['--noEmit'], ['--noEmit', '--watch']]
            },
            vitest: {
                subCommands: {
                    run: {
                        allowAll: true
                    }
                }
            }
        }
    },

    cat: {
        arguments: [[{file: true}]]
    }
}
```

This is pretty self-explanatory. This configuration would allow `npx tsc --noEmit`, `npx vitest run ` followed by whatever, and `cat file`, if the file is in the cwd for the project, and is not in a hidden subdirectory.

Since the order of arguments has meaning, and the meaning depends on the actual command that is run, the `arguments` array is order specific. So in this example, `npx tsc --watch --noEmit` would not be allowed.

To track file location, we should keep track of the cwd of the command. So when analyzing something like `cd .. && cat dir/file.txt` should keep track of the cwd during the cd .. command, then resolve dir/file.txt relative to that, and ensure that it's a non-hidden project file.
