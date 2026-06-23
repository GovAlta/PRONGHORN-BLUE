import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageLoader } from "../PageLoader";

describe("PageLoader", () => {
  it("renders the spinner", () => {
    const { container } = render(<PageLoader />);
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
  });

  it("renders without a message by default", () => {
    render(<PageLoader />);
    const paragraph = screen.queryByRole("paragraph");
    expect(paragraph).not.toBeInTheDocument();
  });

  it("renders the message when provided", () => {
    render(<PageLoader message="Loading data..." />);
    expect(screen.getByText("Loading data...")).toBeInTheDocument();
  });

  it("does not render message text when message is empty string", () => {
    render(<PageLoader message="" />);
    // empty string is falsy, so the <p> is not rendered
    const paragraphs = document.querySelectorAll("p");
    expect(paragraphs).toHaveLength(0);
  });
});
