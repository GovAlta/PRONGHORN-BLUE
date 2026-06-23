import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NavLink } from "../NavLink";

describe("NavLink", () => {
  const renderNavLink = (props: Record<string, unknown> = {}, route: string = "/") =>
    render(
      <MemoryRouter initialEntries={[route]}>
        <NavLink to="/dashboard" {...props}>
          Dashboard
        </NavLink>
      </MemoryRouter>
    );

  it("renders a link with children", () => {
    renderNavLink();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("renders as an anchor element", () => {
    renderNavLink();
    const link = screen.getByRole("link", { name: /dashboard/i });
    expect(link.tagName).toBe("A");
  });

  it("links to the specified path", () => {
    renderNavLink();
    const link = screen.getByRole("link", { name: /dashboard/i });
    expect(link).toHaveAttribute("href", "/dashboard");
  });

  it("applies className prop", () => {
    renderNavLink({ className: "my-class" });
    const link = screen.getByRole("link", { name: /dashboard/i });
    expect(link.className).toContain("my-class");
  });

  it("applies activeClassName when route matches", () => {
    renderNavLink({ activeClassName: "active-link" }, "/dashboard");
    const link = screen.getByRole("link", { name: /dashboard/i });
    expect(link.className).toContain("active-link");
  });

  it("does not apply activeClassName when route does not match", () => {
    renderNavLink({ activeClassName: "active-link" }, "/other");
    const link = screen.getByRole("link", { name: /dashboard/i });
    expect(link.className).not.toContain("active-link");
  });
});
