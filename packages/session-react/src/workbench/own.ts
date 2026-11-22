import {
  PageLinkItems,
  PageNavigationItems,
  PagePictureItems,
  PageTextItems,
} from "../components/page-menu.tsx";
import { PageModeItem } from "../components/page-mode.tsx";
import { PictureItems, PointersItem, ViewportItems } from "../components/picture-menu.tsx";
import {
  KeptItems,
  RecordingSettingsItems,
  RecordItem,
  RunningRecordingItems,
  ScreenshotItem,
} from "../components/recording-menu.tsx";
import { SessionFilesButton } from "../components/session-files.tsx";
import {
  TabCloseItem,
  TabCloseOthersItem,
  TabCloseRightItem,
  TabCopyUrlItem,
  TabDuplicateItem,
  TabMuteItem,
  TabReloadItem,
} from "../components/tab-menu.tsx";
import {
  AppearanceItem,
  BrowserMenuAction,
  DrawAction,
  CopyItem,
  CopyUrlItem,
  KeyboardAction,
  LeaseItems,
  MuteItem,
  NavigationItems,
  PasteItem,
  PictureAction,
  PictureSubmenuItem,
  ReconnectItem,
  RecordingAction,
  RecordingSubmenuItem,
  SelectAllItem,
  TypeItem,
} from "../components/toolbar-actions.tsx";
import type { WorkbenchContribution } from "./contributions.ts";

/**
 * What the workbench puts into its own slots. An embedder's contribution with one of these
 * ids takes that one's place, and a function of this list can leave any of them out.
 */
export const workbenchContributions: readonly WorkbenchContribution[] = [
  { id: "action.keyboard", slot: "toolbar.actions", order: 100, component: KeyboardAction },
  { id: "action.files", slot: "toolbar.actions", order: 200, component: SessionFilesButton },
  { id: "action.draw", slot: "toolbar.actions", order: 250, component: DrawAction },
  { id: "action.recording", slot: "toolbar.actions", order: 300, component: RecordingAction },
  { id: "action.picture", slot: "toolbar.actions", order: 400, component: PictureAction },
  { id: "action.menu", slot: "toolbar.actions", order: 500, component: BrowserMenuAction },

  {
    id: "browser.navigation",
    slot: "menu.browser",
    group: "navigation",
    order: 80,
    component: NavigationItems,
  },
  { id: "browser.lease", slot: "menu.browser", group: "lease", order: 100, component: LeaseItems },
  { id: "browser.copy", slot: "menu.browser", group: "clipboard", order: 200, component: CopyItem },
  {
    id: "browser.paste",
    slot: "menu.browser",
    group: "clipboard",
    order: 300,
    component: PasteItem,
  },
  {
    id: "browser.select-all",
    slot: "menu.browser",
    group: "clipboard",
    order: 400,
    component: SelectAllItem,
  },
  { id: "browser.type", slot: "menu.browser", group: "clipboard", order: 500, component: TypeItem },
  { id: "browser.mute", slot: "menu.browser", group: "tab", order: 600, component: MuteItem },
  {
    id: "browser.recording",
    slot: "menu.browser",
    group: "tab",
    order: 700,
    component: RecordingSubmenuItem,
  },
  {
    id: "browser.picture",
    slot: "menu.browser",
    group: "tab",
    order: 750,
    component: PictureSubmenuItem,
  },
  {
    id: "browser.page-mode",
    slot: "menu.browser",
    group: "tab",
    order: 760,
    component: PageModeItem,
  },
  {
    id: "browser.copy-url",
    slot: "menu.browser",
    group: "tab",
    order: 800,
    component: CopyUrlItem,
  },
  {
    id: "browser.appearance",
    slot: "menu.browser",
    group: "session",
    order: 900,
    component: AppearanceItem,
  },
  {
    id: "browser.reconnect",
    slot: "menu.browser",
    group: "session",
    order: 1000,
    component: ReconnectItem,
  },

  {
    id: "picture.transport",
    slot: "menu.picture",
    group: "picture",
    order: 100,
    component: PictureItems,
  },
  {
    id: "picture.viewport",
    slot: "menu.picture",
    group: "viewport",
    order: 200,
    component: ViewportItems,
  },
  {
    id: "picture.pointers",
    slot: "menu.picture",
    group: "picture",
    order: 150,
    component: PointersItem,
  },

  {
    id: "recording.record",
    slot: "menu.recording",
    group: "take",
    order: 100,
    component: RecordItem,
  },
  {
    id: "recording.screenshot",
    slot: "menu.recording",
    group: "take",
    order: 200,
    component: ScreenshotItem,
  },
  {
    id: "recording.running",
    slot: "menu.recording",
    group: "running",
    order: 300,
    component: RunningRecordingItems,
  },
  { id: "recording.kept", slot: "menu.recording", group: "kept", order: 400, component: KeptItems },
  {
    id: "recording.settings",
    slot: "menu.recording",
    group: "settings",
    order: 500,
    component: RecordingSettingsItems,
  },

  { id: "tab.reload", slot: "menu.tab", group: "tab", order: 100, component: TabReloadItem },
  { id: "tab.duplicate", slot: "menu.tab", group: "tab", order: 200, component: TabDuplicateItem },
  { id: "tab.copy-url", slot: "menu.tab", group: "tab", order: 300, component: TabCopyUrlItem },
  { id: "tab.mute", slot: "menu.tab", group: "tab", order: 400, component: TabMuteItem },
  { id: "tab.close", slot: "menu.tab", group: "close", order: 500, component: TabCloseItem },
  {
    id: "tab.close-others",
    slot: "menu.tab",
    group: "close",
    order: 600,
    component: TabCloseOthersItem,
  },
  {
    id: "tab.close-right",
    slot: "menu.tab",
    group: "close",
    order: 700,
    component: TabCloseRightItem,
  },

  { id: "page.link", slot: "menu.page", group: "link", order: 100, component: PageLinkItems },
  {
    id: "page.picture",
    slot: "menu.page",
    group: "picture",
    order: 200,
    component: PagePictureItems,
  },
  { id: "page.text", slot: "menu.page", group: "text", order: 300, component: PageTextItems },
  {
    id: "page.navigation",
    slot: "menu.page",
    group: "navigation",
    order: 400,
    component: PageNavigationItems,
  },
];
