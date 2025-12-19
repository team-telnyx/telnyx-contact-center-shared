"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";

export async function getProfileAction() {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id || null;
    const email = session?.user?.email || null;
    if (!userId && !email) return { ok: false, error: "Unauthorized" };

    let user = null;
    if (userId) {
      user = await PgDb.findUserById(userId);
    }
    if (!user && email) {
      user = await PgDb.findUserByUsername(email);
    }
    if (!user) return { ok: false, error: "Not found" };
    const sanitized = {
      id: String(user.id),
      firstName: user.first_name || user.firstName || "",
      lastName: user.last_name || user.lastName || "",
      nick: user.nick || "",
      language: user.language || "en-US",
      status: user.status || "Available - ACD",
      mobile: user.mobile || "",
      smsNumber: user.sms_number || user.smsNumber || "",
      voiceNumber: user.voice_number || user.voiceNumber || "",
      profilePictureUri:
        user.profile_picture_uri || user.profilePictureUri || "",
      theme: user.theme || "system",
    };
    return { ok: true, user: sanitized };
  } catch (err) {
    return { ok: false, error: "Server error" };
  }
}

export async function updateProfileAction(formData) {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id || null;
    const email = session?.user?.email || null;
    if (!userId && !email) return { ok: false, error: "Unauthorized" };

    const idForQuery = userId
      ? userId
      : (await PgDb.findUserByUsername(email))?.id;
    if (!idForQuery) return { ok: false, error: "Unauthorized" };

    // Verify user exists before updating
    const current = await PgDb.findUserById(idForQuery);
    if (!current) {
      // Try to find by email as fallback
      const userByEmail = email ? await PgDb.findUserByUsername(email) : null;
      if (userByEmail) {
        // Use the ID from email lookup instead
        const actualId = String(userByEmail.id);
        const updateResult = await updateProfileWithId(
          actualId,
          formData,
          current
        );
        return updateResult;
      }
      return { ok: false, error: "User not found" };
    }

    return await updateProfileWithId(String(idForQuery), formData, current);
  } catch (err) {
    return { ok: false, error: err.message || "Server error" };
  }
}

async function updateProfileWithId(idForQuery, formData, current) {
  try {
    const firstName = (formData.get("firstName") || "").toString();
    const lastName = (formData.get("lastName") || "").toString();
    const nick = (formData.get("nick") || "").toString();
    const language = (formData.get("language") || "en-US").toString();
    const mobile = (formData.get("mobile") || "").toString();
    const smsNumber = (formData.get("smsNumber") || "").toString();
    const voiceNumber = (formData.get("voiceNumber") || "").toString();
    const profilePictureUri = (
      formData.get("profilePictureUri") || ""
    ).toString();
    const status = (formData.get("status") || current?.status || "").toString();
    let theme;
    if (formData.has("theme")) {
      const themeRaw = (formData.get("theme") || "").toString();
      if (["light", "dark", "system"].includes(themeRaw)) theme = themeRaw;
    } else if (!current?.theme) {
      theme = "system";
    }

    const update = {
      firstName,
      lastName,
      nick,
      language,
      status,
      mobile,
      smsNumber,
      voiceNumber,
      profilePictureUri,
    };
    if (typeof theme !== "undefined") update.theme = theme;

    // Ensure ID is a string
    const userId = String(idForQuery);
    await PgDb.updateUserById(userId, update);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || "Server error" };
  }
}

export async function uploadProfilePictureAction(dataUrl) {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id || null;
    const email = session?.user?.email || null;
    if (!userId && !email) return { ok: false, error: "Unauthorized" };
    let idForQuery = userId;
    if (!idForQuery && email) {
      const found = await PgDb.findUserByUsername(email);
      idForQuery = found?.id;
    }
    if (!idForQuery) return { ok: false, error: "Unauthorized" };

    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      return { ok: false, error: "Invalid image data" };
    }

    // Ensure ID is a string
    const userIdStr = String(idForQuery);
    await PgDb.updateUserById(userIdStr, { profilePictureUri: dataUrl });
    return { ok: true, profilePictureUri: dataUrl };
  } catch (err) {
    return { ok: false, error: "Upload failed" };
  }
}

export async function listLanguagesAction() {
  try {
    const rows = await PgDb.listLanguages();
    const languages = rows.map((l) => ({
      id: String(l.id),
      language: l.language || "",
      value: l.value || "",
      flag: l.flag || "",
      microsoftVoice: l.microsoft_voice || "",
      googleVoice: l.google_voice || "",
      amazonVoice: l.amazon_voice || "",
      promptMainMenu: l.prompt_main_menu || "",
      promptWait: l.prompt_wait || "",
      promptTransfer: l.prompt_transfer || "",
      promptBot: l.prompt_bot || "",
      promptDisconnect: l.prompt_disconnect || "",
      promptNoAnswer: l.prompt_no_answer || "",
      promptEnqueued: l.prompt_enqueued || "",
      promptVoicemail: l.prompt_voicemail || "",
      promptIVRError: l.prompt_ivr_error || "",
      promptBye: l.prompt_bye || "",
    }));
    return { ok: true, languages };
  } catch (err) {
    return { ok: false, error: "Failed to fetch languages" };
  }
}

// Auth-related actions moved to app/actions/auth.js
