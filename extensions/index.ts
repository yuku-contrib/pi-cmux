import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cmuxNotifyExtension from "./cmux-notify.ts";
import cmuxSplitExtension from "./cmux-split.ts";
import cmuxStartExtension from "./cmux-start.ts";
import cmuxZoxideExtension from "./cmux-zoxide.ts";
import cmuxContinueExtension from "./cmux-continue.ts";
import cmuxOpenExtension from "./cmux-open.ts";
import cmuxBrowserExtension from "./cmux-browser.ts";
import cmuxSidebarExtension from "./cmux-sidebar.ts";
import cmuxAutotitleExtension from "./cmux-autotitle.ts";
import { initI18n } from "./i18n.ts";

export default function piCmuxExtensionBundle(pi: ExtensionAPI) {
	initI18n(pi);
	cmuxNotifyExtension(pi);
	cmuxSplitExtension(pi);
	cmuxStartExtension(pi);
	cmuxZoxideExtension(pi);
	cmuxContinueExtension(pi);
	cmuxOpenExtension(pi);
	cmuxBrowserExtension(pi);
	cmuxSidebarExtension(pi);
	cmuxAutotitleExtension(pi);
}
