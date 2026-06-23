import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NotFound from "../../pages/NotFound";

describe("NotFound page", () => {
  const renderNotFound = (route: string = "/nonexistent") =>
    render(
      <MemoryRouter initialEntries={[route]}>
        <NotFound />
      </MemoryRouter>
    );

  it("renders the 404 heading", () => {
    renderNotFound();
    expect(screen.getByText("404")).toBeInTheDocument();
  });

  it("renders a descriptive message", () => {
    renderNotFound();
    expect(screen.getByText(/page not found/i)).toBeInTheDocument();
  });

  it("renders a link to home", () => {
    renderNotFound();
    const homeLink = screen.getByRole("link", { name: /return to home/i });
    expect(homeLink).toBeInTheDocument();
    expect(homeLink).toHaveAttribute("href", "/");
  });
});
