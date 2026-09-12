/**
 * The internal planning pill next to a task title.
 *
 * Two things matter: it stays out of the way when the planner has not said
 * anything (null renders nothing at all — no empty span pushing the title
 * line around), and the two states are visually distinct: "in Planung" is
 * the provisional/dashed variant, "bestätigt" the settled green one.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlanningStatusBadge } from "../components/tasks/PlanningStatusBadge";

describe("PlanningStatusBadge", () => {
  it("renders nothing for null or undefined", () => {
    const { container } = render(<PlanningStatusBadge status={null} language="de" />);
    expect(container).toBeEmptyDOMElement();
    const { container: undefinedContainer } = render(
      <PlanningStatusBadge status={undefined} language="de" />,
    );
    expect(undefinedContainer).toBeEmptyDOMElement();
  });

  it("shows 'in Planung' with the tentative (dashed) variant", () => {
    render(<PlanningStatusBadge status="tentative" language="de" />);
    const pill = screen.getByText("in Planung");
    expect(pill).toHaveClass("tasks-page-row-badge");
    expect(pill).toHaveClass("tasks-page-row-badge--planning-tentative");
    expect(pill).not.toHaveClass("tasks-page-row-badge--planning-confirmed");
  });

  it("shows 'bestätigt' with the confirmed (green) variant", () => {
    render(<PlanningStatusBadge status="confirmed" language="de" />);
    const pill = screen.getByText("bestätigt");
    expect(pill).toHaveClass("tasks-page-row-badge");
    expect(pill).toHaveClass("tasks-page-row-badge--planning-confirmed");
    expect(pill).not.toHaveClass("tasks-page-row-badge--planning-tentative");
  });

  it("uses the English words when the UI language is English", () => {
    render(<PlanningStatusBadge status="tentative" language="en" />);
    expect(screen.getByText("tentative")).toBeInTheDocument();
  });

  it("does not say 'bestätigt' in a way that could be read as the customer's answer", () => {
    // The customer dot wording was changed to "Kunde hat bestätigt" precisely
    // so the two "bestätigt"s stay apart; the pill's tooltip names the axis.
    render(<PlanningStatusBadge status="confirmed" language="de" />);
    expect(screen.getByText("bestätigt")).toHaveAttribute("title", expect.stringContaining("Planungsstand"));
  });
});
