"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { revalidatePath } from "next/cache";

async function getCurrentAgentStatus(userId) {
  if (!userId) return "Available";
  try {
    const pool = getPostgresPool();
    if (!pool) return "Available";
    const result = await pool.query(
      `SELECT agent_status FROM cc_agent_state WHERE user_id = $1`,
      [String(userId)],
    );
    return result.rows?.[0]?.agent_status || "Available";
  } catch (_) {
    return "Available";
  }
}

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
    const status = await getCurrentAgentStatus(user.id);
    const sanitized = {
      id: String(user.id),
      firstName: user.first_name || user.firstName || "",
      lastName: user.last_name || user.lastName || "",
      nick: user.nick || "",
      language: user.language || "en-US",
      status,
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

    let current = null;
    if (userId) {
      current = await PgDb.findUserById(userId);
    }
    if (!current && email) {
      current = await PgDb.findUserByUsername(email);
    }
    
    if (!current) return { ok: false, error: "Unauthorized" };
    
    return await updateProfileWithId(String(current.id), formData, current);
  } catch (err) {
    return { ok: false, error: err.message || "Server error" };
  }
}

async function updateProfileWithId(idForQuery, formData, current) {
  try {
    const update = {};
    
    // Only update fields that are provided in formData
    if (formData.has("firstName")) {
      update.firstName = (formData.get("firstName") || "").toString();
    }
    if (formData.has("lastName")) {
      update.lastName = (formData.get("lastName") || "").toString();
    }
    if (formData.has("nick")) {
      update.nick = (formData.get("nick") || "").toString();
    }
    if (formData.has("language")) {
      update.language = (formData.get("language") || "en-US").toString();
    }
    if (formData.has("mobile")) {
      update.mobile = (formData.get("mobile") || "").toString();
    }
    if (formData.has("smsNumber")) {
      update.smsNumber = (formData.get("smsNumber") || "").toString();
    }
    if (formData.has("voiceNumber")) {
      update.voiceNumber = (formData.get("voiceNumber") || "").toString();
    }
    if (formData.has("profilePictureUri")) {
      update.profilePictureUri = (formData.get("profilePictureUri") || "").toString();
    }
    if (formData.has("status")) {
      update.status = (formData.get("status") || current?.status || "").toString();
    }
    
    let theme;
    if (formData.has("theme")) {
      const themeRaw = (formData.get("theme") || "").toString();
      if (["light", "dark", "system"].includes(themeRaw)) theme = themeRaw;
    } else if (!current?.theme) {
      theme = "system";
    }
    if (typeof theme !== "undefined") update.theme = theme;

    // Only update if there are fields to update
    if (Object.keys(update).length === 0) {
      return { ok: true };
    }

    // Ensure ID is a string
    const userId = String(idForQuery);
    await PgDb.updateUserById(userId, update);

    revalidatePath("/");
    revalidatePath("/profile");

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

    let current = null;
    if (userId) {
      current = await PgDb.findUserById(userId);
    }
    if (!current && email) {
      current = await PgDb.findUserByUsername(email);
    }
    if (!current) return { ok: false, error: "Unauthorized" };

    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      return { ok: false, error: "Invalid image data" };
    }

    // Ensure ID is a string
    const userIdStr = String(current.id);
    await PgDb.updateUserById(userIdStr, { profilePictureUri: dataUrl });

    revalidatePath("/");
    revalidatePath("/profile");

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
