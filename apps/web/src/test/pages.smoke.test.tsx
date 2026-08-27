/**
 * Every page mounts, and survives its own visibility toggling.
 *
 * WHY THIS EXISTS. Three page crashes shipped to production in one week, all
 * the same shape and none catchable by the tools in the repo: a hook below an
 * early return. TypeScript cannot see it. The pages are mounted permanently
 * and self-gate on `mainView`, so React runs one set of hooks while a page is
 * hidden and a different set when it is shown — and throws on the change. The
 * page looks fine until somebody navigates to it.
 *
 * So the assertion is deliberately not "the page renders". It is "the page
 * renders, is hidden, and renders again — on the SAME instance". A fresh mount
 * per state would pass happily while production crashed, because React only
 * compares hook counts between renders of one instance. That sequence is the
 * whole point of the file; keep it if you touch anything here.
 *
 * These are smoke tests. They assert that nothing throws, not that anything
 * looks right — with a stubbed context there is nothing meaningful to assert
 * about content. Cheap to keep, and they would have caught all three.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";

import { WerkstattPage } from "../pages/WerkstattPage";
import { TimePage } from "../pages/TimePage";
import { CustomersPage } from "../pages/CustomersPage";
import { MyTasksPage } from "../pages/MyTasksPage";
import { OfficeTasksPage } from "../pages/OfficeTasksPage";
import { ReportsPage } from "../pages/ReportsPage";
import { MessagesPage } from "../pages/MessagesPage";
import { PiStationPage } from "../pages/PiStationPage";

type PageCase = {
  name: string;
  Component: () => JSX.Element | null;
  /** Context where the page shows itself. */
  visible: Record<string, unknown>;
  /**
   * Context where the page hides itself — and, crucially, where the component
   * under test STAYS MOUNTED. Toggling something its parent also guards on
   * unmounts the whole subtree, so every toggle builds a fresh instance and
   * React never compares hook counts. The test then passes on the exact bug
   * it exists to catch. Hide a Werkstatt sub-page by changing the tab, not
   * the view: that is also what a user does.
   */
  hidden: Record<string, unknown>;
};

const PAGES: PageCase[] = [
  // Werkstatt mounts every sub-page at once and each self-gates on its tab,
  // which is the arrangement that made the Bestand crash reachable. Hidden by
  // switching tab, so WerkstattPage itself never unmounts.
  {
    name: "Werkstatt (Bestand)",
    Component: WerkstattPage,
    visible: { mainView: "werkstatt", werkstattTab: "inventar" },
    hidden: { mainView: "werkstatt", werkstattTab: "maschinen" },
  },
  {
    name: "Werkstatt (Maschinen)",
    Component: WerkstattPage,
    visible: { mainView: "werkstatt", werkstattTab: "maschinen" },
    hidden: { mainView: "werkstatt", werkstattTab: "inventar" },
  },
  {
    name: "Werkstatt (Kisten)",
    Component: WerkstattPage,
    visible: { mainView: "werkstatt", werkstattTab: "kisten" },
    hidden: { mainView: "werkstatt", werkstattTab: "inventar" },
  },
  // These are rendered directly here rather than through App, so the component
  // stays mounted while mainView changes and its own guard is what flips.
  { name: "Zeiterfassung", Component: TimePage, visible: { mainView: "time" }, hidden: { mainView: "overview" } },
  { name: "Kunden", Component: CustomersPage, visible: { mainView: "customers" }, hidden: { mainView: "overview" } },
  { name: "Meine Aufgaben", Component: MyTasksPage, visible: { mainView: "my_tasks" }, hidden: { mainView: "overview" } },
  { name: "Aufgaben (Büro)", Component: OfficeTasksPage, visible: { mainView: "office_tasks" }, hidden: { mainView: "overview" } },
  { name: "Berichte", Component: ReportsPage, visible: { mainView: "reports" }, hidden: { mainView: "overview" } },
  { name: "Chat", Component: MessagesPage, visible: { mainView: "messages" }, hidden: { mainView: "overview" } },
  { name: "Scan-Station", Component: PiStationPage, visible: { mainView: "pi_station" }, hidden: { mainView: "overview" } },
];

function providerFor(Component: PageCase["Component"], context: Record<string, unknown>) {
  return (
    <AppContext.Provider value={makeAppContextStub({ overrides: context }) as never}>
      <Component />
    </AppContext.Provider>
  );
}

describe("pages mount without crashing", () => {
  for (const { name, Component, visible, hidden } of PAGES) {
    it(`${name} survives being shown, hidden and shown again`, () => {
      const { rerender } = render(providerFor(Component, visible));

      // Same instance throughout. A hook below the early return changes the
      // hook count on these transitions and React throws — which is exactly
      // how it reaches a user: mid-session, on navigation, not on first load.
      expect(() => {
        rerender(providerFor(Component, hidden));
        rerender(providerFor(Component, visible));
        rerender(providerFor(Component, hidden));
        rerender(providerFor(Component, visible));
      }).not.toThrow();
    });
  }
});
