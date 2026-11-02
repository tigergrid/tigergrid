// Bundle options shared by the standalone binaries (scripts/build.ts) and the Node build
// (scripts/build-node.ts). Both bundle Ink and React into the output, so the npm package and
// the binaries have no runtime dependencies.
import type { BunPlugin } from 'bun';

// Ink dynamically imports react-devtools-core when DEV=true. Neither CLI flag handles that:
// Bun resolves the import before dropping the dead branch (so the build fails), and
// `--external` hoists it into a top-level import (so the output fails at startup). Resolving
// it to an empty module works; the DEV define makes the branch dead anyway, so a user's
// DEV=true does nothing.
const stubDevtools: BunPlugin = {
	name: 'stub-react-devtools-core',
	setup(build) {
		build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
	}
};

export const ENTRYPOINT = 'src/cli.ts';
export const DEFINE = { 'process.env.DEV': JSON.stringify('false') };
export const PLUGINS = [stubDevtools];
