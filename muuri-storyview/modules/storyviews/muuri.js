/*\
title: $:/plugins/BTC/muuri-storyview/storyviews/muuri.js
type: application/javascript
module-type: storyview

Production-ready Muuri storyview for TiddlyWiki5 (parentDomNode container edition)

Key fix vs earlier parent/container attempts
- In TiddlyWiki list widgets, findFirstDomNode() is NOT a stable list root (often the first item).
- The correct render host for the list is listWidget.parentDomNode.
- Therefore:
  - container = listWidget.parentDomNode
  - item query scope root = container (with optional restriction to this list’s titles)

Everything else stays feature complete:
- option pass-through, live apply/recreate fallback
- global registry + connected grids dragSort
- optional global dragContainer
- TW filter-driven filtering
\*/
(function () {
/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

/* ============================== helpers ============================== */

function parseJSON(text) {
	if (!text || typeof text !== "string") return null;
	try { return JSON.parse(text); } catch (e) { return null; }
}

function toPrimitive(text) {
	if (text === null || text === undefined) return undefined;
	var s = String(text).trim();
	if (s === "") return undefined;

	var l = s.toLowerCase();
	if (l === "true" || l === "yes" || l === "1") return true;
	if (l === "false" || l === "no" || l === "0") return false;

	if (/^[+-]?\d+(\.\d+)?$/.test(s)) {
		var n = Number(s);
		if (isFinite(n)) return n;
	}
	return s;
}

function toBool(val) {
	if (val === undefined || val === null) return false;
	var s = String(val).trim().toLowerCase();
	return (s === "true" || s === "yes" || s === "1" || s === "on");
}

function stableSig(v) {
	try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function safe(fn) {
	try { return fn(); } catch (e) { return undefined; }
}

function getMuuriCtor(moduleTitle) {
	try {
		var mod = require(moduleTitle);
		return mod && (mod.Muuri || mod.default || mod);
	} catch (e) {
		return null;
	}
}

function readFnModule(title) {
	try {
		var mod = require(title);
		if (typeof mod === "function") return mod;
		if (mod && typeof mod.default === "function") return mod.default;
		return null;
	} catch (e) {
		return null;
	}
}

function ensureGlobalRegistry() {
	if (!$tw.muuriGrid) $tw.muuriGrid = [];
	if (!Array.isArray($tw.muuriGrid)) $tw.muuriGrid = [];
	return $tw.muuriGrid;
}

function addToRegistry(grid) {
	var reg = ensureGlobalRegistry();
	if (reg.indexOf(grid) === -1) reg.push(grid);
}

function removeFromRegistry(grid) {
	var reg = ensureGlobalRegistry();
	var idx = reg.indexOf(grid);
	if (idx !== -1) reg.splice(idx, 1);
}

function getGridElement(grid) {
	return safe(function () { return grid.getElement(); }) ||
		grid._element ||
		null;
}

function splitClasses(text) {
	var s = String(text || "").trim();
	return s ? s.split(/\s+/g) : [];
}

function applyStyleDeclarations(el, cssText) {
	if (!(el instanceof Element)) return;
	var text = String(cssText || "").trim();
	if (!text) return;

	// Parse "prop: value; prop2: value2" into setProperty calls.
	// Avoid clobbering existing inline styles (no cssText overwrite).
	var decls = text.split(";");
	for (var i = 0; i < decls.length; i++) {
		var d = decls[i].trim();
		if (!d) continue;
		var idx = d.indexOf(":");
		if (idx <= 0) continue;
		var prop = d.slice(0, idx).trim();
		var val = d.slice(idx + 1).trim();
		if (!prop) continue;
		safe(function () { el.style.setProperty(prop, val); });
	}
}

function isElementInDom(el) {
	return !!(el && el instanceof Element && el.isConnected);
}

/* ============================== policy ============================== */

var RECREATE_IF_CHANGED = {
	// Changing selector changes item identity => recreate is safest.
	itemsSelector: true,

	itemClass: true,
	itemVisibleClass: true,
	itemHiddenClass: true,
	itemPositioningClass: true,
	itemDraggingClass: true,
	itemReleasingClass: true,
	itemPlaceholderClass: true,

	dragContainer: true
};

/* ============================== storyview ============================== */

function MuuriStoryView(listWidget) {
	this.listWidget = listWidget;

	this._muuri = null;
	this._muuriCtor = null;

	// In TW, findFirstDomNode() is not reliable as "list root".
	// We keep it only for attribute reading fallback + debugging.
	this._listNode = null;

	// Container must be the list render host.
	this._container = null; // listWidget.parentDomNode

	this._attrObserver = null;
	this._syncInProgress = false;

	// Connection support
	this._connectSelector = null;
	this._connectProvidesDragSort = false;

	// Drag container integration
	this._globalDragContainerSelector = ".tc-muuri-drag-container";
	this._connectProvidesDragContainer = false;

	// Live filtering (TW filter)
	this._filteringEnabled = false;
	this._twFilterExpression = "";
	this._twFilterSource = "title";
	this._twAllowedTitles = null; // Set<string> or null meaning "show all"

	this._lastState = null;
	// ✅ CREATE GRID ASAP (but after TW attaches DOM)
	var self = this;
	var kick = function () { self._syncFromAttributes(); };

	kick();

	if ($tw && $tw.utils && typeof $tw.utils.nextTick === "function") {
		$tw.utils.nextTick(kick);
	} else {
		setTimeout(kick, 0);
	}
}

/* ============================== DOM resolution ============================== */

MuuriStoryView.prototype._resolveListDomNode = function () {
	var el = this.listWidget && this.listWidget.findFirstDomNode && this.listWidget.findFirstDomNode();
	return (el instanceof Element) ? el : null;
};

MuuriStoryView.prototype._getListDomNode = function () {
	// Best-effort; may point to first item
	if (this._listNode && this._listNode.isConnected) return this._listNode;
	this._listNode = this._resolveListDomNode();
	return this._listNode;
};

MuuriStoryView.prototype._getHostDomNode = function () {
	// This is the correct DOM node the list renders into
	var host = this.listWidget && this.listWidget.parentDomNode;
	return (host instanceof Element) ? host : null;
};

MuuriStoryView.prototype._getAttr = function (node, name) {
	// Read attributes from the list widget (preferred) and/or DOM node fallback.
	if (this.listWidget && this.listWidget.getAttribute) {
		var v = this.listWidget.getAttribute(name);
		if (v !== undefined && v !== null) return v;
	}
	if (node) return node.getAttribute(name);
	return null;
};

MuuriStoryView.prototype._ensureContainer = function (state) {
	// FIX: container is listWidget.parentDomNode (the list’s render host), not parent of findFirstDomNode()
	var host = this._getHostDomNode();
	if (!host) return null;

	// Cache invalidation if host changed/replaced
	if (this._container && this._container !== host) {
		this._container = null;
	}
	this._container = host;

	// Mark + enforce without clobbering existing style/class
	host.setAttribute("data-muuri-storyview-container", "1");

	// Enforced style
	safe(function () { host.style.setProperty("display", "grid"); });
	safe(function () { host.style.setProperty("position", "relative"); });
	safe(function () { host.style.setProperty("overflow", "visible"); });
	safe(function () { host.style.setProperty("min-width", "0"); });
	safe(function () { host.style.setProperty("min-height", "0"); });

	// Extra style/class from attributes
	applyStyleDeclarations(host, state.containerStyle);

	var extraClasses = splitClasses(state.containerClass);
	if (host.classList) {
		host.classList.add("muuri-storyview-container");
		for (var i = 0; i < extraClasses.length; i++) host.classList.add(extraClasses[i]);
	} else {
		// fallback
		var add = " muuri-storyview-container" + (extraClasses.length ? (" " + extraClasses.join(" ")) : "");
		if (String(host.className || "").indexOf("muuri-storyview-container") === -1) {
			host.className = String(host.className || "") + add;
		}
	}

	return host;
};

MuuriStoryView.prototype._getListTitlesSet = function () {
	// Strong filter to avoid accidentally collecting items from other lists in the same host.
	// For story river it usually matches exactly.
	var titles = safe(function () {
		return this.listWidget && this.listWidget.getTiddlerList && this.listWidget.getTiddlerList();
	}.bind(this));

	if (!Array.isArray(titles)) return null;
	var set = new Set();
	for (var i = 0; i < titles.length; i++) set.add(titles[i]);
	return set;
};

MuuriStoryView.prototype._getItemElements = function (state) {
	// FIX: scope root is the container (host dom node), not the list node.
	var host = this._getHostDomNode();
	if (!host) return [];

	var sel = String(state.itemsSelector || ".tc-tiddler-frame").trim() || ".tc-tiddler-frame";
	var nodeList = safe(function () { return host.querySelectorAll(sel); });
	if (!nodeList || !nodeList.length) return [];

	var nodes = Array.prototype.slice.call(nodeList);

	// Restrict to only those titles produced by THIS list widget (prevents cross-list bleed).
	// Fail-open if we can't determine titles.
	var allowed = this._getListTitlesSet();
	if (!allowed) return nodes;

	var out = [];
	for (var i = 0; i < nodes.length; i++) {
		var el = nodes[i];
		if (!(el instanceof Element)) continue;

		var t = el.getAttribute("data-tiddler-title") || el.getAttribute("data-tiddler") || null;
		if (t && allowed.has(t)) out.push(el);
	}
	return out;
};

/* ============================== state ============================== */

MuuriStoryView.prototype._readStateFromAttributes = function () {
	var listNode = this._getListDomNode();
	var hostNode = this._getHostDomNode(); // attributes may also be set on the DOM node in some setups
	var attrs = (listNode && listNode.attributes) ? listNode.attributes :
		(hostNode && hostNode.attributes) ? hostNode.attributes : null;

	var state = {
		moduleTitle: "$:/plugins/BTC/muuri-storyview/lib/muuri.js",
		itemsSelector: ".tc-tiddler-frame",
		containerClass: "",
		containerStyle: "",
		connectSelector: "",
		globalDragContainerSelector: ".tc-muuri-drag-container",

		// filtering (TW)
		filteringEnabled: false,
		twFilterExpression: "",
		twFilterSource: "title",

		options: {}
	};

	// Read from widget attrs first; DOM fallback to listNode/hostNode
	var moduleTitle = this._getAttr(listNode, "muuri-module-title") || this._getAttr(hostNode, "muuri-module-title");
	if (moduleTitle) state.moduleTitle = moduleTitle;

	var itemsSel = this._getAttr(listNode, "muuri-items-selector") || this._getAttr(hostNode, "muuri-items-selector");
	if (itemsSel) state.itemsSelector = itemsSel;

	var cClass = this._getAttr(listNode, "muuri-container-class") || this._getAttr(hostNode, "muuri-container-class");
	if (cClass) state.containerClass = cClass;

	var cStyle = this._getAttr(listNode, "muuri-container-style") || this._getAttr(hostNode, "muuri-container-style");
	if (cStyle) state.containerStyle = cStyle;

	var connSel = this._getAttr(listNode, "muuri-connect-selector") || this._getAttr(hostNode, "muuri-connect-selector");
	if (connSel) state.connectSelector = connSel;

	var gdcSel = this._getAttr(listNode, "muuri-global-drag-container-selector") || this._getAttr(hostNode, "muuri-global-drag-container-selector");
	if (gdcSel) state.globalDragContainerSelector = gdcSel;

	// Filtering attributes
	state.filteringEnabled = toBool(this._getAttr(listNode, "muuri-enable-filtering") || this._getAttr(hostNode, "muuri-enable-filtering"));
	var twExpr = this._getAttr(listNode, "muuri-tw-filter") || this._getAttr(hostNode, "muuri-tw-filter");
	if (twExpr) state.twFilterExpression = twExpr;

	var twSrc = this._getAttr(listNode, "muuri-tw-filter-source") || this._getAttr(hostNode, "muuri-tw-filter-source");
	if (twSrc) state.twFilterSource = twSrc;

	// Default options: we will set opts.items later (scoped elements), so do NOT set options.items to a selector here.

	// Bulk JSON (highest priority)
	var bulk = this._getAttr(listNode, "muuri-opt-json") || this._getAttr(hostNode, "muuri-opt-json");
	if (bulk) {
		var obj = parseJSON(bulk);
		if (obj && typeof obj === "object" && !Array.isArray(obj)) {
			for (var k0 in obj) state.options[k0] = obj[k0];
		}
	}

	// Individual muuri-opt-* (from whichever attrs are visible)
	if (attrs) {
		for (var i = 0; i < attrs.length; i++) {
			var name = attrs[i].name;
			var val = attrs[i].value;
			if (name.indexOf("muuri-opt-") === 0) {
				var optName = name.slice("muuri-opt-".length);
				if (!optName) continue;
				var jsonVal = parseJSON(val);
				state.options[optName] = (jsonVal !== null ? jsonVal : toPrimitive(val));
			}
		}
	}

	// Function options muuri-fn-*
	if (attrs) {
		for (i = 0; i < attrs.length; i++) {
			name = attrs[i].name;
			val = attrs[i].value;
			if (name.indexOf("muuri-fn-") === 0) {
				optName = name.slice("muuri-fn-".length);
				if (!optName) continue;
				var fn = readFnModule(val);
				if (fn) state.options[optName] = fn;
			}
		}
	}

	if (state.options.layoutDuration === undefined || state.options.layoutDuration === null) {
		state.options.layoutDuration = $tw.utils.getAnimationDuration();
	}

	state.sig = stableSig({
		moduleTitle: state.moduleTitle,
		itemsSelector: state.itemsSelector,
		containerClass: state.containerClass,
		containerStyle: state.containerStyle,
		connectSelector: state.connectSelector,
		globalDragContainerSelector: state.globalDragContainerSelector,

		filteringEnabled: state.filteringEnabled,
		twFilterExpression: state.twFilterExpression,
		twFilterSource: state.twFilterSource,

		options: state.options
	});

	return state;
};

/* ============================== attribute watching ============================== */

MuuriStoryView.prototype._installAttributeWatcher = function () {
	if (this._attrObserver || typeof MutationObserver === "undefined") return;

	// Watch the WIDGET'S DOM node if present; otherwise watch the host container.
	// This is best-effort; most real changes will come from widget refresh anyway.
	var node = this._getListDomNode() || this._getHostDomNode();
	if (!node) return;

	var self = this;
	this._attrObserver = new MutationObserver(function (mutations) {
		for (var i = 0; i < mutations.length; i++) {
			var m = mutations[i];
			if (m.type !== "attributes") continue;
			var n = m.attributeName || "";
			if (n.indexOf("muuri-") === 0) {
				self._syncFromAttributes();
				break;
			}
		}
	});
	this._attrObserver.observe(node, { attributes: true });
};

/* ============================== destruction ============================== */

MuuriStoryView.prototype._destroyMuuri = function () {
	if (this._muuri) {
		removeFromRegistry(this._muuri);
		safe(function () { this._muuri.destroy(true); }.bind(this));
		this._muuri = null;
	}
	this._muuriCtor = null;
};

/* ============================== connecting grids ============================== */

MuuriStoryView.prototype._makeConnectedDragSortFn = function () {
	var self = this;
	return function connectedDragSort(/* item */) {
		var selector = self._connectSelector;
		if (!selector) return self._muuri ? [self._muuri] : [];

		var reg = ensureGlobalRegistry();
		var result = [];
		for (var i = 0; i < reg.length; i++) {
			var g = reg[i];
			// We tag grids with __twHost for matching.
			var host = g && g.__twHost;
			if (!(host instanceof Element)) continue;

			// Heuristic: match selector against the host itself OR a closest ancestor.
			// (Many users will provide something like ".tc-story-river".)
			if ((host.matches && host.matches(selector)) ||
				(host.closest && host.closest(selector))) {
				result.push(g);
			}
		}

		if (self._muuri && result.indexOf(self._muuri) === -1) result.push(self._muuri);
		return result;
	};
};

/* ============================== drag container integration ============================== */

MuuriStoryView.prototype._resolveGlobalDragContainer = function () {
	var sel = this._globalDragContainerSelector || ".tc-muuri-drag-container";
	var el = safe(function () { return document.querySelector(sel); });
	return el || document.body;
};

MuuriStoryView.prototype._applyConnectionPolicy = function (state) {
	this._connectSelector = state.connectSelector || "";
	this._globalDragContainerSelector = state.globalDragContainerSelector || ".tc-muuri-drag-container";

	var userSetDragSort = (state.options.dragSort !== undefined && state.options.dragSort !== null);
	if (this._connectSelector && !userSetDragSort) {
		this._connectProvidesDragSort = true;
		state.options.dragSort = this._makeConnectedDragSortFn();
	} else {
		this._connectProvidesDragSort = false;
	}

	var userSetDragContainer = (state.options.dragContainer !== undefined && state.options.dragContainer !== null);
	if (this._connectSelector && !userSetDragContainer) {
		this._connectProvidesDragContainer = true;
		state.options.dragContainer = this._resolveGlobalDragContainer();
	} else {
		this._connectProvidesDragContainer = false;
	}
};

/* ============================== TW filter-based filtering ============================== */

MuuriStoryView.prototype._extractTitleFromElement = function (element, state) {
	if (!(element instanceof Element)) return null;

	var src = (state.twFilterSource || "title").trim();

	// dataset:<key>
	if (src.indexOf("dataset:") === 0) {
		var key = src.slice("dataset:".length).trim();
		if (key) return element.dataset ? (element.dataset[key] || null) : null;
	}

	// field:<attrname>  (read as attribute on the element)
	if (src.indexOf("field:") === 0) {
		var attr = src.slice("field:".length).trim();
		if (attr) return element.getAttribute(attr) || null;
	}

	// title (default): attempt common TW DOM markers, walking up until host
	var host = this._getHostDomNode();
	var el = element;
	while (el && el instanceof Element) {
		var t =
			el.getAttribute("data-tiddler-title") ||
			el.getAttribute("data-tiddler") ||
			el.getAttribute("title");
		if (t) return t;

		if (host && el === host) break;
		el = el.parentElement;
	}
	return null;
};

MuuriStoryView.prototype._recomputeAllowedTitles = function (state) {
	this._filteringEnabled = !!state.filteringEnabled;
	this._twFilterExpression = state.twFilterExpression || "";
	this._twFilterSource = state.twFilterSource || "title";

	var expr = String(this._twFilterExpression || "").trim();
	if (!this._filteringEnabled || expr === "") {
		this._twAllowedTitles = null;
		return;
	}

	var titles = safe(function () {
		return $tw.wiki.filterTiddlers(expr, this.listWidget);
	}.bind(this));

	if (!Array.isArray(titles)) {
		this._twAllowedTitles = null; // fail open
		return;
	}

	var set = new Set();
	for (var i = 0; i < titles.length; i++) set.add(titles[i]);
	this._twAllowedTitles = set;
};

MuuriStoryView.prototype._applyFiltering = function (state) {
	if (!this._muuri || typeof this._muuri.filter !== "function") return;

	this._recomputeAllowedTitles(state);

	var allowed = this._twAllowedTitles;
	if (!allowed) {
		safe(function () {
			this._muuri.filter(function () { return true; });
		}.bind(this));
		return;
	}

	safe(function () {
		this._muuri.filter(function (item, element) {
			var title = this._extractTitleFromElement(element, state);
			return title ? allowed.has(title) : false;
		}.bind(this));
	}.bind(this));
};

/* ============================== lifecycle ============================== */

MuuriStoryView.prototype._ensureMuuri = function (state) {
	console.log("ensuring muuri");
	if (this._muuri) return this._muuri;

	var host = this._getHostDomNode();
	if (!host) return null;

	var container = this._ensureContainer(state);
	if (!container) return null;

	this._applyConnectionPolicy(state);

	this._muuriCtor = getMuuriCtor(state.moduleTitle);
	if (!this._muuriCtor) return null;

	// Scope items strictly to the HOST (parentDomNode)
	var items = this._getItemElements(state);

	// Pass scoped elements as "items" so Muuri doesn't scan arbitrary host descendants.
	var opts = {};
	for (var k in state.options) opts[k] = state.options[k];
	opts.items = items;

	this._muuri = new this._muuriCtor(container, opts);

	// Tag grid for registry scanning / debugging
	this._muuri.__twMuuriStoryView = true;
	this._muuri.__twListNode = this._getListDomNode(); // best-effort (may be first item)
	this._muuri.__twHost = host;
	this._muuri.__twContainer = container;

	addToRegistry(this._muuri);

	safe(function () { this._muuri.refreshItems(items, true).layout(); }.bind(this));

	this._applyFiltering(state);
	this._installAttributeWatcher();

	return this._muuri;
};

MuuriStoryView.prototype._needsRecreate = function (prevState, nextState, changedKeys) {
	if (prevState.moduleTitle !== nextState.moduleTitle) return true;
	for (var i = 0; i < changedKeys.length; i++) {
		if (RECREATE_IF_CHANGED[changedKeys[i]]) return true;
	}
	return false;
};

MuuriStoryView.prototype._applyLive = function (nextState, changedKeys) {
	var grid = this._muuri;
	if (!grid) return false;

	return !!safe(function () {
		this._ensureContainer(nextState);
		this._applyConnectionPolicy(nextState);

		if (!grid._settings) return false;

		// Connection-provided settings
		if (this._connectProvidesDragSort) grid._settings.dragSort = nextState.options.dragSort;
		if (this._connectProvidesDragContainer) grid._settings.dragContainer = nextState.options.dragContainer;

		// Apply changed keys into Muuri settings best-effort
		for (var i = 0; i < changedKeys.length; i++) {
			var key = changedKeys[i];
			if (key === "dragSort" && this._connectProvidesDragSort) continue;
			if (key === "dragContainer" && this._connectProvidesDragContainer) continue;
			grid._settings[key] = nextState.options[key];
		}

		// Update drag enabled state for existing items
		if (changedKeys.indexOf("dragEnabled") !== -1) {
			var enable = !!nextState.options.dragEnabled;
			var items0 = safe(function () { return grid.getItems(); }) || [];
			for (i = 0; i < items0.length; i++) {
				var it = items0[i];
				var d = it && (it._drag || (it.getDrag && it.getDrag()));
				if (d) {
					if (enable && d.enable) d.enable();
					if (!enable && d.disable) d.disable();
				}
			}
		}

		// Refresh items/layout because TW updates DOM independently
		var items = this._getItemElements(nextState);
		if (grid.refreshItems) grid.refreshItems(items, true);
		if (grid.layout) grid.layout();

		this._applyFiltering(nextState);

		return true;
	}.bind(this));
};

MuuriStoryView.prototype._syncFromAttributes = function () {
	if (this._syncInProgress) return;
	this._syncInProgress = true;

	try {
		var next = this._readStateFromAttributes();

		// If host changed/replaced, safest is recreate.
		var hostNow = this._getHostDomNode();
		if (!hostNow) {
			// Nothing to do; keep things quiet.
			return;
		}
		if (this._muuri && this._muuri.__twHost && hostNow !== this._muuri.__twHost) {
			this._destroyMuuri();
		}

		this._ensureContainer(next);
		this._applyConnectionPolicy(next);

		if (!this._lastState) {
			this._lastState = next;
			this._ensureMuuri(next);
			return;
		}

		if (this._lastState.sig === next.sig) {
			// Still refresh items/layout because DOM might have changed (TW renders independently)
			if (this._muuri) {
				var itemsSame = this._getItemElements(next);
				safe(function () { this._muuri.refreshItems(itemsSame, true).layout(); }.bind(this));
				this._applyFiltering(next);
			}
			return;
		}

		var prevOpts = this._lastState.options || {};
		var nextOpts = next.options || {};
		var changedKeys = [];
		var keySet = {};
		var k;

		for (k in prevOpts) keySet[k] = true;
		for (k in nextOpts) keySet[k] = true;
		for (k in keySet) {
			if (stableSig(prevOpts[k]) !== stableSig(nextOpts[k])) changedKeys.push(k);
		}

		// Also treat itemsSelector as a change key for recreate policy
		if (this._lastState.itemsSelector !== next.itemsSelector) changedKeys.push("itemsSelector");

		var mustRecreate = this._needsRecreate(this._lastState, next, changedKeys);

		if (!this._muuri) {
			this._lastState = next;
			this._ensureMuuri(next);
			return;
		}

		if (!mustRecreate) {
			var ok = this._applyLive(next, changedKeys);
			if (ok) {
				this._lastState = next;
				return;
			}
			mustRecreate = true;
		}

		if (mustRecreate) {
			this._destroyMuuri();
			this._lastState = next;
			this._ensureMuuri(next);
		}
	} finally {
		this._syncInProgress = false;
	}
};

/* ============================== TW storyview API ============================== */

MuuriStoryView.prototype.navigateTo = function (historyInfo) {
	var listElementIndex = this.listWidget.findListItem(0, historyInfo.title);
	if (listElementIndex === undefined) return;

	var listItemWidget = this.listWidget.children[listElementIndex];
	var targetElement = listItemWidget && listItemWidget.findFirstDomNode && listItemWidget.findFirstDomNode();
	if (!(targetElement instanceof Element)) return;

	this.listWidget.dispatchEvent({ type: "tm-scroll", target: targetElement });
};

MuuriStoryView.prototype.insert = function (widget) {
	// Do NOT append/move nodes. TW owns DOM. We only refresh Muuri.
	this._syncFromAttributes();
	if (this._muuri) {
		var state = this._lastState || this._readStateFromAttributes();
		var items = this._getItemElements(state);
		safe(function () { this._muuri.refreshItems(items, true).layout(); }.bind(this));
		this._applyFiltering(state);
	}
};

MuuriStoryView.prototype.remove = function (widget) {
	widget.removeChildDomNodes();
	if (this._muuri) {
		var state = this._lastState || this._readStateFromAttributes();
		var items = this._getItemElements(state);
		safe(function () { this._muuri.refreshItems(items, true).layout(); }.bind(this));
		this._applyFiltering(state);
	}
};

MuuriStoryView.prototype.destroy = function () {
	if (this._attrObserver) {
		safe(function () { this._attrObserver.disconnect(); }.bind(this));
		this._attrObserver = null;
	}
	this._destroyMuuri();
	this._lastState = null;
	this._container = null;
	this._listNode = null;
};

exports.muuri = MuuriStoryView;

})();
