I think we need to upgrade our testing setup.

Currently we're running a bunch of stuff in tmp directories, but I want magenta to be a more cross-file-system type agent, and not restricted to a single nvim working directory in the future.

I'd like to introduce a new kind of test - an integration test.

This should spin up a docker container containing nvim, magenta.nvim, and all the requried dependencies: typescript, cmp, treesitter, etc...

It should then run vitest inside of that container.

That vitest should use the same preamble harness, but now without tmp dirs. Instead, we should be able to set up options in ~/.magenta/options.json, and mess around with accessing different directories, secrets, etc...

I wonder how we can reset the state of the container between every test, so there's no pollution? I think restarting the container every time will be prohibitively slow... but maybe I'm wrong about that?
