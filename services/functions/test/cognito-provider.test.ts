import { describe, expect, it, vi } from "vitest";
import { CognitoOtpProvider } from "../src/handlers/auth-otp.js";

describe("CognitoOtpProvider", () => {
  it("creates a missing admin, adds the ADMIN group, then starts auth", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        ChallengeName: "EMAIL_OTP",
        Session: "otp-session",
        ChallengeParameters: { CODE_DELIVERY_DESTINATION: "p***@example.com" },
      });
    const provider = new CognitoOtpProvider({ send } as never);
    await expect(provider.start("pilot@example.com", "client", "pool", true)).resolves.toMatchObject({
      session: "otp-session",
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        UserPoolId: "pool",
        Username: "pilot@example.com",
        MessageAction: "SUPPRESS",
        UserAttributes: expect.arrayContaining([{ Name: "email_verified", Value: "true" }]),
      },
    });
    expect(send.mock.calls[0]?.[0]?.input).not.toHaveProperty("TemporaryPassword");
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      input: { UserPoolId: "pool", Username: "pilot@example.com", GroupName: "ADMIN" },
    });
    expect(send.mock.calls[2]?.[0]).toMatchObject({
      input: { AuthFlow: "USER_AUTH", AuthParameters: { PREFERRED_CHALLENGE: "EMAIL_OTP" } },
    });
  });

  it("treats create-existing as success and does not call the group API for a regular user", async () => {
    const exists = Object.assign(new Error("exists"), { name: "UsernameExistsException" });
    const send = vi.fn()
      .mockRejectedValueOnce(exists)
      .mockResolvedValueOnce({
        ChallengeName: "EMAIL_OTP",
        Session: "otp-session",
      });
    const provider = new CognitoOtpProvider({ send } as never);
    await provider.start("regular@example.com", "client", "pool", false);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: { UserPoolId: "pool", Username: "regular@example.com", MessageAction: "SUPPRESS" },
    });
    expect(send.mock.calls[1]?.[0]).toMatchObject({ input: { AuthFlow: "USER_AUTH" } });
  });

  it("uses EMAIL_OTP_CODE and returns both OAuth tokens", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({
        AuthenticationResult: { AccessToken: "access-token", IdToken: "id-token" },
      })
      .mockResolvedValueOnce({
        Username: "sub-1",
        UserAttributes: [
          { Name: "sub", Value: "sub-1" },
          { Name: "email", Value: "pilot@example.com" },
        ],
      });
    const provider = new CognitoOtpProvider({ send } as never);
    await expect(provider.verify("pilot@example.com", "123456", "session", "client")).resolves.toMatchObject({
      accessToken: "access-token",
      idToken: "id-token",
      userId: "sub-1",
    });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        ChallengeName: "EMAIL_OTP",
        ChallengeResponses: {
          USERNAME: "pilot@example.com",
          EMAIL_OTP_CODE: "123456",
        },
      },
    });
    expect(send.mock.calls[0]?.[0]?.input.ChallengeResponses).not.toHaveProperty("EMAIL_OTP");
  });
});
