import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../context/ThemeContext", () => ({
  useTheme: () => ({ isDark: false }),
}));

const oauthStatus = vi.fn();

vi.mock("../../api/modules/auth", () => ({
  authApi: {
    getAuthStatus: () => Promise.resolve({ setup_required: false }),
    getOauthStatus: () => oauthStatus(),
    getCaptcha: () => Promise.resolve({ provider: "none" }),
    getLdapStatus: () => Promise.resolve({ enabled: false, display_name: "" }),
    getPasskeyLoginStatus: () => Promise.resolve({ passwordless_login: false }),
  },
}));

vi.mock("../../utils/locale", () => ({
  applyGuestLocale: () => Promise.resolve(),
  applyUserLocale: () => Promise.resolve(),
}));

import LoginPage from "./index";

describe("Login page", () => {
  it("offers the WeChat QR code instead of a password form", async () => {
    oauthStatus.mockResolvedValue({
      providers: [{ kind: "wechat_open", display_name: "微信", enabled: true }],
    });

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    const button = await screen.findByRole("button", {
      name: /login\.oidcWith/,
    });
    // A brand icon (img) is rendered instead of the generic key fallback.
    expect(button.querySelector("img")).not.toBeNull();
    expect(
      screen.queryByPlaceholderText(
        /login\.username|用户名或邮箱|username or email/i,
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/login\.password|密码|password/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("login-forgot-password-toggle"),
    ).not.toBeInTheDocument();
  });

  it("renders the remember-me checkbox by default", async () => {
    oauthStatus.mockResolvedValue({
      providers: [{ kind: "wechat_open", display_name: "微信", enabled: true }],
    });

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    const checkbox = await screen.findByRole("checkbox", {
      name: /login\.remember|记住登录状态|Remember me/,
    });
    expect(checkbox).toBeChecked();
  });

  it("tells the user when no sign-in method is enabled", async () => {
    oauthStatus.mockResolvedValue({ providers: [] });

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("login.noProviderEnabled"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
