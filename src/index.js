import './styles/sticky-header.css';

import { StickyHeader } from './components/sticky-header.js';
import { StickyContent } from './components/sticky-content.js';
import { SETTLE_LINEAR_CURVE, makeSettleEase } from './lib/easing.js';
// TEMPORARY, with the vendored copy in src/lib: exported so a page can reach
// the same scroll-handler singleton the header is driven by — to share it with
// other consumers, or to flip `quietOnHeightResize`. Once the npm dependency
// replaces the vendoring, consumers import it from that package instead.
import { ScrollHandler } from './lib/scroll-handler.js';

export { StickyHeader, StickyContent, SETTLE_LINEAR_CURVE, makeSettleEase, ScrollHandler };
