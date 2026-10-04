import { webcrypto } from "node:crypto";
import { createContext, runInContext } from "node:vm";

// Minimal DOM for protocol/state tests; layout is checked separately in real WKWebView.
export function annotationPage() {
	class Element {
		constructor(tag = "div", id = "") {
			this.tagName = tag.toUpperCase(); this.localName = tag; this.id = id;
			this.style = {}; this.hidden = false; this.value = ""; this.textContent = ""; this.innerText = "";
			this.isConnected = true; this.children = []; this.listeners = new Map(); this.attributes = {};
			this.offsetWidth = 290; this.offsetHeight = 73; this.scrollHeight = 28;
		}
		append(child) { child.parentElement = this; this.children.push(child); }
		setAttribute(key, value) { this.attributes[key] = value; }
		addEventListener(name, callback) { const list = this.listeners.get(name) ?? []; list.push(callback); this.listeners.set(name, list); }
		emit(name, event = {}) { for (const callback of this.listeners.get(name) ?? []) callback(event); }
		click() { this.emit("click", {}); }
		focus() {}
		scrollIntoView() {}
		matchesControl() { return ["INPUT", "TEXTAREA", "SELECT"].includes(this.tagName) || this.editable; }
		closest() { return this.matchesControl() ? this : this.parentElement?.closest() ?? null; }
		querySelector() {
			for (const child of this.children) {
				const match = child.matchesControl() ? child : child.querySelector();
				if (match) return match;
			}
			return null;
		}
		getBoundingClientRect() { return { top: 100, bottom: 200, left: 20, width: 200, height: 100 }; }
		attachShadow() { return root; }
	}
	const root = { elements: new Map(), querySelector(selector) { return this.elements.get(selector); } };
	for (const selector of [".note", ".ring", ".hover", ".launcher", ".status", ".send", ".close", "textarea"]) {
		root.elements.set(selector, new Element(selector === "textarea" ? "textarea" : "div"));
	}
	const document = new Element();
	document.body = new Element("body"); document.documentElement = new Element("html");
	document.documentElement.append(document.body);
	document.title = "Example page"; document.contentType = "text/html";
	document.createElement = tag => new Element(tag);
	const card = new Element("article", "card"); card.innerText = "Revenue $100";
	const other = new Element("article", "other"); other.innerText = "Customers";
	document.body.append(card); document.body.append(other);
	const location = { href: "https://example.test/" };
	let now = 1000;
	const intervals = new Set();
	const context = createContext({
		document, location, Element, crypto: webcrypto, CSS: { escape: s => s }, innerWidth: 640, innerHeight: 800,
		Date: { now: () => now }, addEventListener() {},
		setInterval(fn) { intervals.add(fn); return fn; }, clearInterval(fn) { intervals.delete(fn); },
	});
	return {
		context, document, location, card, other, Element,
		q: selector => root.querySelector(selector),
		eval: script => JSON.parse(JSON.stringify(runInContext(script, context))),
		select(element = card) {
			document.emit("click", { target: element, composedPath: () => [element, document.body], preventDefault() {}, stopImmediatePropagation() {} });
		},
		type(value) { root.querySelector("textarea").value = value; root.querySelector("textarea").emit("input"); },
		advance(ms) { now += ms; for (const tick of [...intervals]) tick(); },
	};
}
