import { supabase } from "./client"
import type { UIMessage } from "ai"
import { v4 as uuidv4 } from "uuid"
import type { FileUploadResult } from "./file-upload"

// Helper functions
function generateShareToken(): string {
  // Generate a URL-safe random token
  const array = new Uint8Array(16)
  crypto.getRandomValues(array)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
}

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hash = await crypto.subtle.digest("SHA-256", data)
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const hashedPassword = await hashPassword(password)
  return hashedPassword === hash
}

// Add a new function to archive/unarchive a thread
export const toggleThreadArchived = async (threadId: string, isArchived: boolean) => {
  const { data, error } = await supabase
    .from("threads")
    .update({
      is_archived: isArchived,
      updated_at: new Date().toISOString(),
    })
    .eq("id", threadId)
    .select()
    .single()

  if (error) throw error
  return data
}

// Update the getThreads function to filter out archived threads by default
export const getThreads = async (includeArchived = false) => {
  let query = supabase.from("threads").select("*").order("last_message_at", { ascending: false })

  if (!includeArchived) {
    query = query.eq("is_archived", false)
  }

  const { data, error } = await query

  if (error) throw error
  return data || []
}

export const createThread = async (id: string, projectId?: string) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { data, error } = await supabase
    .from("threads")
    .insert({
      id,
      title: "New Chat",
      user_id: user.id,
      project_id: projectId || null,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

export const updateThread = async (id: string, title: string) => {
  const { data, error } = await supabase
    .from("threads")
    .update({
      title,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single()

  if (error) throw error
  return data
}

export const deleteThread = async (id: string) => {
  const { error } = await supabase.from("threads").delete().eq("id", id)

  if (error) throw error
}

export const deleteAllThreads = async () => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { error } = await supabase.from("threads").delete().eq("user_id", user.id)

  if (error) throw error
}

export const getMessagesByThreadId = async (threadId: string) => {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })

  if (error) throw error
  
  // Process messages to include file content for file attachments
  const messagesWithFileContent = await Promise.all(
    (data || []).map(async (message) => {
      // Check if message has file attachments in parts
      if (message.parts) {
        const updatedParts = await Promise.all(
          message.parts.map(async (part: any) => {
            if (part.type?.toString() === "file_attachments" && part.attachments) {
              // Fetch content for each attachment that doesn't already have it
              const attachmentsWithContent = await Promise.all(
                part.attachments.map(async (attachment: any) => {
                  // If attachment already has content, return as-is
                  if (attachment.content || attachment.extractedText) {
                    return attachment
                  }
                  
                  // If attachment has a fileUrl, try to fetch the content
                  if (attachment.fileUrl) {
                    try {
                      console.log(`📄 Fetching content for file: ${attachment.fileName}`)
                      const response = await fetch(attachment.fileUrl)
                      if (response.ok) {
                        const content = await response.text()
                        console.log(`✅ Fetched content for ${attachment.fileName}: ${content.length} chars`)
                        return {
                          ...attachment,
                          content: content,
                          extractedText: content, // For compatibility
                        }
                      } else {
                        console.warn(`⚠️ Failed to fetch content for ${attachment.fileName}: ${response.status}`)
                      }
                    } catch (error) {
                      console.error(`❌ Error fetching content for ${attachment.fileName}:`, error)
                    }
                  }
                  
                  // Return attachment without content if we can't fetch it
                  return attachment
                })
              )
              
              return {
                ...part,
                attachments: attachmentsWithContent
              }
            }
            return part
          })
        )
        
        return {
          ...message,
          parts: updatedParts
        }
      }
      
      return message
    })
  )
  
  return messagesWithFileContent
}

export const getFileAttachmentsByMessageId = async (messageId: string) => {
  const { data, error } = await supabase
    .from("file_attachments")
    .select("*")
    .eq("message_id", messageId)
    .order("created_at", { ascending: true })

  if (error) throw error
  return data || []
}

export const getFileAttachmentsByThreadId = async (threadId: string) => {
  const { data, error } = await supabase
    .from("file_attachments")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })

  if (error) throw error
  return data || []
}

export const createMessage = async (threadId: string, message: UIMessage, fileAttachments?: FileUploadResult[]) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  console.log("🔍 Creating message:", {
    messageId: message.id,
    threadId,
    userId: user.id,
    role: message.role,
    hasAttachments: !!fileAttachments?.length,
  })

  // Ensure thread exists first - this is critical for Ollama models
  try {
    const { data: existingThread, error: threadCheckError } = await supabase
      .from("threads")
      .select("id")
      .eq("id", threadId)
      .eq("user_id", user.id)
      .single()

    if (threadCheckError && threadCheckError.code === "PGRST116") {
      // Thread doesn't exist, create it
      console.log("🔗 Thread doesn't exist, creating it before message...")
      const { error: createError } = await supabase.from("threads").insert({
        id: threadId,
        title: "New Chat",
        user_id: user.id,
      })

      if (createError) {
        console.error("❌ Failed to create thread:", createError)
        throw createError
      }
      console.log("✅ Thread created successfully")
    } else if (threadCheckError) {
      // Some other error occurred
      console.error("❌ Thread check failed:", threadCheckError)
      throw threadCheckError
    } else {
      console.log("✅ Thread already exists")
    }
  } catch (error) {
    console.error("❌ Error ensuring thread exists:", error)
    throw error
  }

  // Update message parts to include file attachments if any
  const updatedParts = [...(message.parts || [])]

  if (fileAttachments && fileAttachments.length > 0) {
    // Add file attachments to message parts (using type assertion for custom type)
    updatedParts.push({
      type: "file_attachments" as any,
      attachments: fileAttachments.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        fileType: attachment.fileType,
        fileSize: attachment.size || 0,
        fileUrl: attachment.url,
        thumbnailUrl: attachment.thumbnailUrl,
        content: attachment.content, // Include content in message parts
        extractedText: attachment.extractedText,
      })),
    } as any)
  }

  // Ensure we have a valid UUID for the message ID
  const messageId = message.id && message.id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) 
    ? message.id 
    : uuidv4()

  console.log("🔍 Message ID validation:", {
    originalId: message.id,
    isValidUUID: message.id && message.id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    finalId: messageId
  })

  // Use upsert to handle potential race conditions
  const { error: messageError } = await supabase.from("messages").upsert({
    id: messageId,
    thread_id: threadId,
    user_id: user.id,
    parts: updatedParts,
    role: message.role,
    content: message.content,
    created_at: (message.createdAt || new Date()).toISOString(),
  }, {
    onConflict: 'id',
    ignoreDuplicates: false
  })

  if (messageError) {
    console.error("❌ Failed to create message:", messageError)
    // Log more details about the error
    if (messageError && typeof messageError === 'object') {
      console.error("❌ Message creation error details:", {
        message: messageError.message,
        code: messageError.code,
        details: messageError.details,
        hint: messageError.hint
      })
    }
    throw messageError
  }

  console.log("✅ Message created successfully")

  // Insert file attachments if any
  if (fileAttachments && fileAttachments.length > 0) {
    // Log the file attachments for debugging
    console.log(
      "📎 File attachments to insert:",
      fileAttachments.map((f) => ({
        fileName: f.fileName,
        fileType: f.fileType,
        size: f.size,
        url: f.url,
      })),
    )

    try {
      const attachmentsToInsert = fileAttachments
        .filter((attachment) => {
          // Only include attachments that have a valid URL
          if (!attachment.fileUrl && !attachment.url) {
            console.warn("⚠️ Skipping attachment without URL:", attachment.fileName)
            return false
          }
          return true
        })
        .map((attachment) => {
          // Generate a new ID if one doesn't exist
          const attachmentId = attachment.id || uuidv4()

          // Use the correct property names based on the FileUploadResult interface
          return {
            id: attachmentId,
            message_id: messageId,
            thread_id: threadId,
            user_id: user.id,
            file_name: attachment.fileName,
            file_type: attachment.fileType || "text/plain",
            file_size: attachment.fileSize || 0,
            file_url: attachment.fileUrl || attachment.url || "", // Use empty string as fallback instead of null
            thumbnail_url: attachment.thumbnailUrl || null,
            created_at: new Date().toISOString(),
          }
        })

      // Only proceed if we have valid attachments to insert
      if (attachmentsToInsert.length > 0) {
        console.log("💾 Inserting file attachments:", attachmentsToInsert)

        const { error: attachmentsError } = await supabase.from("file_attachments").insert(attachmentsToInsert)

        if (attachmentsError) {
          console.error("❌ Failed to create file attachments:", attachmentsError)
          throw attachmentsError
        }

        console.log("✅ File attachments created successfully")
      } else {
        console.log("ℹ️ No valid file attachments to insert")
      }
    } catch (error) {
      console.error("❌ Error processing file attachments:", error)
      // Don't throw here as the message was created successfully
    }
  }

  const { error: threadError } = await supabase
    .from("threads")
    .update({
      last_message_at: (message.createdAt || new Date()).toISOString(),
    })
    .eq("id", threadId)

  if (threadError) {
    console.error("❌ Failed to update thread:", threadError)
    throw threadError
  }

  console.log("✅ Thread updated successfully")
}

export const deleteTrailingMessages = async (threadId: string, createdAt: Date, gte = true) => {
  const operator = gte ? "gte" : "gt"
  const { error } = await supabase
    .from("messages")
    .delete()
    .eq("thread_id", threadId)
    [operator]("created_at", createdAt.toISOString())

  if (error) throw error
}

export const createMessageSummary = async (threadId: string, messageId: string, content: string) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { data, error } = await supabase
    .from("message_summaries")
    .insert({
      id: uuidv4(),
      thread_id: threadId,
      message_id: messageId,
      user_id: user.id,
      content,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

export const getMessageSummaries = async (threadId: string) => {
  const { data, error } = await supabase
    .from("message_summaries")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })

  if (error) throw error
  return data || []
}

export const getFirstUserMessage = async (threadId: string) => {
  const { data, error } = await supabase
    .from("messages")
    .select("id, content, created_at")
    .eq("thread_id", threadId)
    .eq("role", "user")
    .order("created_at", { ascending: true })
    .limit(1)
    .single()

  if (error) {
    if (error.code === "PGRST116") {
      // No rows found
      return null
    }
    throw error
  }
  return data
}

// Chat Sharing Functions
export const createSharedThread = async (
  threadId: string,
  title: string,
  description?: string,
  isPublic = true,
  password?: string,
  expiresAt?: Date,
) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  // Generate a unique share token
  const shareToken = generateShareToken()

  // Hash password if provided
  let passwordHash: string | undefined
  if (password) {
    passwordHash = await hashPassword(password)
  }

  const { data, error } = await supabase
    .from("shared_threads")
    .insert({
      thread_id: threadId,
      user_id: user.id,
      share_token: shareToken,
      title,
      description,
      is_public: isPublic,
      password_hash: passwordHash,
      expires_at: expiresAt?.toISOString(),
    })
    .select()
    .single()

  if (error) throw error
  return data
}

// Updated functions to use API routes for public access
export const getSharedThread = async (shareToken: string, password?: string) => {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }

    if (password) {
      // Use POST request with password
      const response = await fetch(`/api/shared/${shareToken}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ password }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to access shared conversation")
      }

      return await response.json()
    } else {
      // Use GET request without password
      const response = await fetch(`/api/shared/${shareToken}`, {
        method: "GET",
        headers,
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to access shared conversation")
      }

      return await response.json()
    }
  } catch (error) {
    console.error("Failed to get shared thread:", error)
    throw error
  }
}

export const getSharedThreadMessages = async (shareToken: string) => {
  try {
    const response = await fetch(`/api/shared/${shareToken}/messages`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || "Failed to load messages")
    }

    return await response.json()
  } catch (error) {
    console.error("Failed to get shared thread messages:", error)
    throw error
  }
}

export const getUserSharedThreads = async () => {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) throw new Error("User not authenticated")

    console.log("🔍 Loading shared threads for user:", user.id)

    const { data, error } = await supabase
      .from("shared_threads")
      .select("*, threads(title)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })

    if (error) {
      console.error("❌ Shared threads query error:", error)
      // Log more details about the error
      if (error && typeof error === 'object') {
        console.error("❌ Shared threads error details:", {
          message: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint
        })
      }
      throw error
    }

    console.log("✅ Shared threads loaded successfully:", data?.length || 0)
    return data || []
  } catch (error) {
    console.error("❌ Failed to get user shared threads:", error)
    throw error
  }
}

export const updateSharedThread = async (
  id: string,
  updates: {
    title?: string
    description?: string
    is_public?: boolean
    password?: string
    expires_at?: Date | null
  },
) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const updateData: any = {
    ...updates,
    updated_at: new Date().toISOString(),
  }

  // Handle password update
  if (updates.password !== undefined) {
    if (updates.password) {
      updateData.password_hash = await hashPassword(updates.password)
    } else {
      updateData.password_hash = null
    }
    delete updateData.password
  }

  // Handle expires_at
  if (updates.expires_at !== undefined) {
    updateData.expires_at = updates.expires_at?.toISOString() || null
  }

  const { data, error } = await supabase
    .from("shared_threads")
    .update(updateData)
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single()

  if (error) throw error
  return data
}

export const deleteSharedThread = async (id: string) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { error } = await supabase.from("shared_threads").delete().eq("id", id).eq("user_id", user.id)

  if (error) throw error
}

export const getSharedThreadByThreadId = async (threadId: string) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { data, error } = await supabase
    .from("shared_threads")
    .select("*")
    .eq("thread_id", threadId)
    .eq("user_id", user.id)
    .single()

  if (error && error.code !== "PGRST116") throw error // PGRST116 is "not found"
  return data || null
}

// Project Functions
export const getProjects = async () => {
  const { data, error } = await supabase
    .from("projects")
    .select("*, threads(count)")
    .order("created_at", { ascending: false })

  if (error) throw error
  return data || []
}

export const createProject = async (name: string, description?: string, color?: string) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { data, error } = await supabase
    .from("projects")
    .insert({
      name,
      description,
      color: color || "#6366f1",
      user_id: user.id,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

export const updateProject = async (id: string, updates: { name?: string; description?: string; color?: string }) => {
  const { data, error } = await supabase
    .from("projects")
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single()

  if (error) throw error
  return data
}

export const deleteProject = async (id: string) => {
  const { error } = await supabase.from("projects").delete().eq("id", id)

  if (error) throw error
}

export const getThreadsByProject = async (projectId: string) => {
  const { data, error } = await supabase
    .from("threads")
    .select("*")
    .eq("project_id", projectId)
    .order("last_message_at", { ascending: false })

  if (error) throw error
  return data || []
}

export const moveThreadToProject = async (threadId: string, projectId: string | null) => {
  const { data, error } = await supabase
    .from("threads")
    .update({
      project_id: projectId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", threadId)
    .select()
    .single()

  if (error) throw error
  return data
}

// Code Conversion Functions
export const saveCodeConversion = async (
  threadId: string,
  messageId: string,
  originalCode: string,
  originalLanguage: string,
  convertedCode: string,
  targetLanguage: string,
) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  console.log("💾 Saving code conversion:", {
    threadId,
    messageId,
    originalLanguage,
    targetLanguage,
  })

  // Generate a UUID for the conversion ID
  const conversionId = uuidv4()

  const { data, error } = await supabase
    .from("code_conversions")
    .insert({
      id: conversionId,
      thread_id: threadId,
      message_id: messageId, // Now accepts string IDs
      user_id: user.id,
      original_code: originalCode,
      original_language: originalLanguage,
      converted_code: convertedCode,
      target_language: targetLanguage,
    })
    .select()
    .single()

  if (error) {
    console.error("❌ Failed to save code conversion:", error)
    throw error
  }

  console.log("✅ Code conversion saved successfully")
  return data
}

export const getCodeConversions = async (threadId: string, messageId: string) => {
  try {
    console.log("🔍 Getting code conversions for:", { threadId, messageId })

    const { data, error } = await supabase
      .from("code_conversions")
      .select("*")
      .eq("thread_id", threadId)
      .eq("message_id", messageId)
      .order("created_at", { ascending: false }) // Change to descending to get newest first

    if (error) {
      console.error("❌ Failed to get code conversions:", error)
      throw error
    }

    console.log(`✅ Found ${data?.length || 0} code conversions`)
    return data || []
  } catch (error) {
    console.error("❌ Failed to get code conversions:", error)
    throw error
  }
}

export const getFileAttachmentsWithContent = async (messageId: string) => {
  const { data, error } = await supabase
    .from("file_attachments")
    .select("*")
    .eq("message_id", messageId)
    .order("created_at", { ascending: true })

  if (error) throw error

  // For each attachment, try to fetch the content if we have a URL
  const attachmentsWithContent = await Promise.all(
    (data || []).map(async (attachment) => {
      try {
        if (attachment.file_url) {
          // Try to fetch the file content
          const response = await fetch(attachment.file_url)
          if (response.ok) {
            const content = await response.text()
            return {
              id: attachment.id,
              fileName: attachment.file_name,
              fileType: attachment.file_type,
              fileSize: attachment.file_size,
              fileUrl: attachment.file_url,
              thumbnailUrl: attachment.thumbnail_url,
              content: content,
              extractedText: content, // For compatibility
            }
          }
        }

        // Return without content if we can't fetch it
        return {
          id: attachment.id,
          fileName: attachment.file_name,
          fileType: attachment.file_type,
          fileSize: attachment.file_size,
          fileUrl: attachment.file_url,
          thumbnailUrl: attachment.thumbnail_url,
        }
      } catch (error) {
        console.error("Error fetching file content:", error)
        return {
          id: attachment.id,
          fileName: attachment.file_name,
          fileType: attachment.file_type,
          fileSize: attachment.file_size,
          fileUrl: attachment.file_url,
          thumbnailUrl: attachment.thumbnail_url,
        }
      }
    }),
  )

  return attachmentsWithContent
}

// Pinned Messages Functions
export const pinMessage = async (threadId: string, messageId: string, note?: string) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { data, error } = await supabase
    .from("pinned_messages")
    .insert({
      user_id: user.id,
      thread_id: threadId,
      message_id: messageId,
      note: note || null,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

export const unpinMessage = async (threadId: string, messageId: string) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { error } = await supabase
    .from("pinned_messages")
    .delete()
    .eq("user_id", user.id)
    .eq("thread_id", threadId)
    .eq("message_id", messageId)

  if (error) throw error
}

export const getPinnedMessages = async (threadId: string) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { data, error } = await supabase
    .from("pinned_messages")
    .select(`
      *,
      messages (
        id,
        content,
        role,
        parts,
        created_at,
        user_id
      )
    `)
    .eq("user_id", user.id)
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })

  if (error) throw error
  return data || []
}

export const getAllPinnedMessages = async () => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { data, error } = await supabase
    .from("pinned_messages")
    .select(`
      *,
      messages (
        id,
        content,
        role,
        parts,
        created_at,
        user_id
      ),
      threads (
        id,
        title
      )
    `)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })

  if (error) throw error
  return data || []
}

export const updatePinnedMessageNote = async (pinnedMessageId: string, note: string) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { data, error } = await supabase
    .from("pinned_messages")
    .update({
      note,
      updated_at: new Date().toISOString(),
    })
    .eq("id", pinnedMessageId)
    .eq("user_id", user.id)
    .select()
    .single()

  if (error) throw error
  return data
}

export const isPinned = async (threadId: string, messageId: string): Promise<boolean> => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return false

  const { data, error } = await supabase
    .from("pinned_messages")
    .select("id")
    .eq("user_id", user.id)
    .eq("thread_id", threadId)
    .eq("message_id", messageId)
    .single()

  if (error && error.code !== "PGRST116") throw error // PGRST116 is "not found"
  return !!data
}

// Thread Persona Functions
export const setThreadPersona = async (threadId: string, personaId: string) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  // Check if the thread exists, if not create it
  const { data: existingThread, error: threadCheckError } = await supabase
    .from("threads")
    .select("id")
    .eq("id", threadId)
    .eq("user_id", user.id)
    .single()

  if (threadCheckError && threadCheckError.code === "PGRST116") {
    // Thread doesn't exist, create it
    console.log("🔗 Thread doesn't exist, creating it before setting persona...")
    const { error: createError } = await supabase.from("threads").insert({
      id: threadId,
      title: "New Chat",
      user_id: user.id,
    })

    if (createError) {
      console.error("❌ Failed to create thread:", createError)
      throw createError
    }
    console.log("✅ Thread created successfully")
  } else if (threadCheckError) {
    // Some other error occurred
    throw threadCheckError
  }

  // First, delete any existing thread persona for this user and thread
  await supabase.from("thread_personas").delete().eq("thread_id", threadId).eq("user_id", user.id)

  // Then insert the new thread persona
  const { data, error } = await supabase
    .from("thread_personas")
    .insert({
      thread_id: threadId,
      persona_id: personaId,
      user_id: user.id,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

export const getThreadPersona = async (threadId: string) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { data, error } = await supabase
    .from("thread_personas")
    .select(`
      *,
      personas (
        id,
        name,
        description,
        system_prompt,
        avatar_emoji,
        color,
        is_default,
        is_public
      )
    `)
    .eq("thread_id", threadId)
    .eq("user_id", user.id)
    .single()

  if (error && error.code !== "PGRST116") throw error // PGRST116 is "not found"
  return data?.personas || null
}

export const removeThreadPersona = async (threadId: string) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { error } = await supabase.from("thread_personas").delete().eq("thread_id", threadId).eq("user_id", user.id)

  if (error) throw error
}

export const getUserProfile = async (userId: string) => {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).single()

  if (error && error.code !== "PGRST116") throw error // PGRST116 is "not found"
  return data || null // Explicitly return null if no data
}

export const createUserProfile = async (userId: string, profileData?: {
  username?: string
  full_name?: string
  avatar_url?: string
}) => {
  const { data, error } = await supabase
    .from("profiles")
    .insert({
      id: userId,
      username: profileData?.username || null,
      full_name: profileData?.full_name || null,
      avatar_url: profileData?.avatar_url || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) throw error
  return data
}

export const updateUserProfile = async (updates: {
  username?: string
  full_name?: string
  avatar_url?: string
}) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  // Use upsert to handle cases where profile doesn't exist yet
  const { data, error } = await supabase
    .from("profiles")
    .upsert(
      {
        id: user.id,
        ...updates,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    )
    .select()
    .single()

  if (error) throw error
  return data
}

// Function to update a message in the database
export const updateMessageInDatabase = async (messageId: string, newContent: string): Promise<boolean> => {
  console.log("🔄 updateMessageInDatabase called for message:", messageId)
  console.log("📝 New content preview:", newContent.substring(0, 200))

  try {
    // Get current user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      console.error("❌ User not authenticated:", authError)
      return false
    }

    console.log("👤 User authenticated:", user.id)

    // First, let's check what message we're trying to update
    const { data: messageCheck, error: checkError } = await supabase
      .from("messages")
      .select("id, user_id, thread_id, role, content")
      .eq("id", messageId)
      .single()

    if (checkError) {
      console.error("❌ Failed to check message:", checkError)
      return false
    }

    console.log("📄 Message to update:", {
      id: messageCheck.id,
      user_id: messageCheck.user_id,
      thread_id: messageCheck.thread_id,
      role: messageCheck.role,
      contentLength: messageCheck.content.length,
      contentPreview: messageCheck.content.substring(0, 100),
    })

    // Check if this is a user message or assistant message
    const isUserMessage = messageCheck.user_id === user.id
    const isAssistantMessage = messageCheck.role === "assistant"

    console.log("🔍 Message type analysis:", {
      isUserMessage,
      isAssistantMessage,
      messageUserId: messageCheck.user_id,
      currentUserId: user.id,
      messageRole: messageCheck.role,
    })

    let updateResult

    if (isUserMessage) {
      console.log("👤 Updating user message...")
      // Update user message
      updateResult = await supabase
        .from("messages")
        .update({
          content: newContent,
          updated_at: new Date().toISOString(), // Add updated_at timestamp
        })
        .eq("id", messageId)
        .eq("user_id", user.id)
        .select()
    } else if (isAssistantMessage) {
      console.log("🤖 Updating assistant message...")
      // For assistant messages, verify the thread belongs to the user
      const { data: threadCheck, error: threadError } = await supabase
        .from("threads")
        .select("id, user_id")
        .eq("id", messageCheck.thread_id)
        .eq("user_id", user.id)
        .single()

      if (threadError) {
        console.error("❌ Thread verification failed:", threadError)
        return false
      }

      console.log("✅ Thread verified, belongs to user:", threadCheck.user_id)

      // Update assistant message in user's thread
      updateResult = await supabase
        .from("messages")
        .update({
          content: newContent,
          updated_at: new Date().toISOString(), // Add updated_at timestamp
        })
        .eq("id", messageId)
        .eq("thread_id", messageCheck.thread_id)
        .select()
    } else {
      console.error("❌ Unknown message type or permission denied")
      return false
    }

    const { data: updatedData, error: updateError } = updateResult

    if (updateError) {
      console.error("❌ Failed to update message:", updateError)
      console.error("❌ Update error details:", {
        code: updateError.code,
        message: updateError.message,
        details: updateError.details,
        hint: updateError.hint,
      })
      return false
    }

    if (!updatedData || updatedData.length === 0) {
      console.error("❌ No rows were updated - this might indicate a permission issue")
      return false
    }

    console.log("✅ Message updated successfully:", {
      updatedRows: updatedData.length,
      newContentLength: updatedData[0].content.length,
      newContentPreview: updatedData[0].content.substring(0, 100),
    })

    // Double-check by fetching the message again
    const { data: verifyData, error: verifyError } = await supabase
      .from("messages")
      .select("content")
      .eq("id", messageId)
      .single()

    if (verifyError) {
      console.error("❌ Failed to verify update:", verifyError)
      return false
    }

    if (verifyData.content === newContent) {
      console.log("✅ Update verified - content matches expected value")
      return true
    } else {
      console.error("❌ Update verification failed - content doesn't match:", {
        expected: newContent.substring(0, 100),
        actual: verifyData.content.substring(0, 100),
        expectedLength: newContent.length,
        actualLength: verifyData.content.length,
      })
      return false
    }
  } catch (error) {
    console.error("❌ Unexpected error in updateMessageInDatabase:", error)
    return false
  }
}

// User Preferences Functions
export const getUserPreferences = async () => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  try {
    const { data, error } = await supabase
      .from("user_preferences")
      .select("*")
      .eq("user_id", user.id)
      .single()

    if (error && error.code !== "PGRST116") {
      // PGRST116 is "not found" which is fine
      // 42P01 is "relation does not exist" (table doesn't exist)
      if (error.code === "42P01") {
        console.warn("📋 user_preferences table does not exist yet, falling back to localStorage")
        return null
      }
      throw error
    }
    return data || null
  } catch (error: any) {
    console.warn("📋 Failed to query user_preferences table:", error.message)
    return null
  }
}

export const saveUserPreferences = async (preferences: {
  preferred_name?: string
  occupation?: string
  assistant_traits?: string[]
  custom_instructions?: string
  ui_font?: string
  code_font?: string
  font_size?: "small" | "medium" | "large"
  selected_model?: string
  enabled_models?: string[]
  favorite_models?: string[]
}) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  try {
    // Check if preferences already exist
    const { data: existing } = await supabase
      .from("user_preferences")
      .select("id")
      .eq("user_id", user.id)
      .single()

    if (existing) {
      // Update existing preferences
      const { data, error } = await supabase
        .from("user_preferences")
        .update({
          ...preferences,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .select()
        .single()

      if (error) throw error
      return data
    } else {
      // Insert new preferences
      const { data, error } = await supabase
        .from("user_preferences")
        .insert({
          user_id: user.id,
          ...preferences,
        })
        .select()
        .single()

      if (error) throw error
      return data
    }
  } catch (error: any) {
    // If table doesn't exist, just log and return - preferences will work from localStorage
    if (error.code === "42P01") {
      console.warn("📋 user_preferences table does not exist yet, preferences will only be stored locally")
      return null
    }
    console.warn("📋 Failed to save user preferences to database:", error.message)
    throw error
  }
}

export const deleteUserPreferences = async () => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  const { error } = await supabase.from("user_preferences").delete().eq("user_id", user.id)

  if (error) throw error
}

// File Attachment Functions
export const getAllFileAttachments = async () => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  // First get all threads to get their titles
  const { data: threads, error: threadsError } = await supabase
    .from("threads")
    .select("id, title")
    .eq("user_id", user.id)

  if (threadsError) throw threadsError

  // Create a map of thread IDs to titles
  const threadTitles: Record<string, string> = {}
  threads?.forEach((thread) => {
    threadTitles[thread.id] = thread.title
  })

  // Get all file attachments for the user
  const { data, error } = await supabase
    .from("file_attachments")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })

  if (error) throw error

  // Add thread titles to the file attachments
  return (data || []).map((file) => ({
    ...file,
    thread_title: threadTitles[file.thread_id] || "Unknown Thread",
  }))
}

export const deleteFileAttachment = async (fileId: string) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not authenticated")

  // First get the file to get its URL
  const { data: file, error: fileError } = await supabase
    .from("file_attachments")
    .select("file_url")
    .eq("id", fileId)
    .eq("user_id", user.id)
    .single()

  if (fileError) throw fileError

  // Delete the file from storage if it exists
  if (file?.file_url) {
    try {
      // Extract the path from the URL
      const url = new URL(file.file_url)
      const pathMatch = url.pathname.match(/\/storage\/v1\/object\/public\/thread-files\/(.+)/)

      if (pathMatch && pathMatch[1]) {
        const path = pathMatch[1]
        await supabase.storage.from("thread-files").remove([path])
      }
    } catch (error) {
      console.error("Failed to delete file from storage:", error)
      // Continue with deleting the record even if storage deletion fails
    }
  }

  // Delete the file record from the database
  const { error } = await supabase.from("file_attachments").delete().eq("id", fileId).eq("user_id", user.id)

  if (error) throw error
}
