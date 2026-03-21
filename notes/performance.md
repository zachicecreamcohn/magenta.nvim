I've noticed some performance degradation since we've split the project into a core & main, especially after we ported threads into core.

The observed effect is that the CPU spikes, the rendering becomes slow, and I notice lag during rendering, especially in applying marks/colors to the views.

It seems to occur once the plugin is in use for a while - so it could be that we're attaching more and more listeners to the core, and causing multiple dispatches for every action, which are causing a lot of compute to happen.

Some possible reasons to investigate:

- maybe there's some looping that's happening between the core thread and the root thread. Maybe we're causing a lot of cycles of update -> event emitted -> dispatch -> update, etc...

- subscription around the root <-> core thread. Is it possible we're oversubscribing or over-dispatching, so we're ending up doing many view updates for every dispatch?

- expensive computation. We end up parsing out info from the completed results on every update... maybe we need to memoize that (once the completed response is seen once, it's immutable nad it won't change).
