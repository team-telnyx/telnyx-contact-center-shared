/**
 * Data Sources Schema Utility
 * Provides schema definitions and utilities for Contacts, KB Articles, and Tasks
 */

/**
 * Get entity schema definition
 * @param {string} entityId - Entity identifier (contacts, kb_articles, tasks)
 * @returns {Object} Schema definition with field metadata
 */
export function getEntitySchema(entityId) {
  switch (entityId) {
    case "contacts":
      return {
        id: {
          type: "string",
          required: true,
          autoGenerate: true,
          description: "Unique identifier for the contact",
        },
        first_name: {
          type: "string",
          required: false,
          description: "First name of the contact",
        },
        last_name: {
          type: "string",
          required: false,
          description: "Last name of the contact",
        },
        display_name: {
          type: "string",
          required: false,
          description: "Display name for the contact",
        },
        company_name: {
          type: "string",
          required: false,
          description: "Company name",
        },
        phone: {
          type: "string",
          required: false,
          description: "Primary phone number",
        },
        mobile: {
          type: "string",
          required: false,
          description: "Mobile phone number",
        },
        email_address_1: {
          type: "string",
          required: false,
          description: "Primary email address",
        },
        email_address_2: {
          type: "string",
          required: false,
          description: "Secondary email address",
        },
        notes: {
          type: "string",
          required: false,
          description: "Additional notes about the contact",
        },
        custom_data: {
          type: "object",
          required: false,
          description: "Custom JSON object with additional contact data",
        },
        created_at: {
          type: "string",
          required: false,
          autoGenerate: true,
          description: "Timestamp when the contact was created",
        },
        updated_at: {
          type: "string",
          required: false,
          autoGenerate: true,
          description: "Timestamp when the contact was last updated",
        },
      };
    case "kb_articles":
      return {
        id: {
          type: "string",
          required: true,
          autoGenerate: true,
          description: "Unique identifier for the article",
        },
        title: {
          type: "string",
          required: true,
          description: "Title of the knowledge base article",
        },
        slug: {
          type: "string",
          required: true,
          description: "URL-friendly slug for the article",
        },
        summary: {
          type: "string",
          required: false,
          description: "Brief summary of the article",
        },
        content: {
          type: "string",
          required: true,
          description: "Full content of the article",
        },
        category: {
          type: "string",
          required: true,
          description: "Category of the article",
        },
        subcategory: {
          type: "string",
          required: false,
          description: "Subcategory of the article",
        },
        tags: {
          type: "array",
          required: false,
          description: "Array of tags for categorization",
        },
        keywords: {
          type: "array",
          required: false,
          description: "Array of keywords for search",
        },
        status: {
          type: "enum",
          required: true,
          enum: ["Draft", "Published", "Archived"],
          description: "Publication status of the article",
        },
        language: {
          type: "string",
          required: false,
          description: "Language code (default: 'en')",
        },
        custom_data: {
          type: "object",
          required: false,
          description: "Custom JSON object with additional article data",
        },
        published_at: {
          type: "string",
          required: false,
          description: "Timestamp when the article was published",
        },
        created_at: {
          type: "string",
          required: false,
          autoGenerate: true,
          description: "Timestamp when the article was created",
        },
        updated_at: {
          type: "string",
          required: false,
          autoGenerate: true,
          description: "Timestamp when the article was last updated",
        },
      };
    case "tasks":
      return {
        id: {
          type: "string",
          required: true,
          autoGenerate: true,
          description: "Unique identifier for the task",
        },
        title: {
          type: "string",
          required: true,
          description: "Title of the task",
        },
        description: {
          type: "string",
          required: false,
          description: "Detailed description of the task",
        },
        task_type: {
          type: "string",
          required: true,
          description:
            "Type of task (e.g., incident, sales_query, complaint, or custom)",
        },
        status: {
          type: "enum",
          required: true,
          enum: ["open", "in_progress", "resolved", "closed", "cancelled"],
          description: "Current status of the task",
        },
        priority: {
          type: "enum",
          required: false,
          enum: ["low", "medium", "high", "urgent"],
          description: "Priority level of the task",
        },
        caller_name: {
          type: "string",
          required: false,
          description: "Name of the caller associated with the task",
        },
        caller_phone: {
          type: "string",
          required: false,
          description: "Phone number of the caller",
        },
        caller_email: {
          type: "string",
          required: false,
          description: "Email address of the caller",
        },
        contact_id: {
          type: "string",
          required: false,
          description: "ID of the linked contact (if applicable)",
        },
        assigned_to: {
          type: "string",
          required: false,
          description: "ID of the user assigned to handle the task",
        },
        due_date: {
          type: "string",
          required: false,
          description: "Due date for the task (ISO 8601 format)",
        },
        tags: {
          type: "array",
          required: false,
          description: "Array of tags for categorization",
        },
        metadata: {
          type: "object",
          required: false,
          description: "Flexible JSON object for type-specific data",
        },
        custom_data: {
          type: "object",
          required: false,
          description: "Custom JSON object with additional task data",
        },
        created_at: {
          type: "string",
          required: false,
          autoGenerate: true,
          description: "Timestamp when the task was created",
        },
        updated_at: {
          type: "string",
          required: false,
          autoGenerate: true,
          description: "Timestamp when the task was last updated",
        },
      };
    default:
      return {};
  }
}

/**
 * Get base API path for entity
 * @param {string} entityId - Entity identifier
 * @returns {string} Base API path
 */
export function getEntityBasePath(entityId) {
  switch (entityId) {
    case "contacts":
      return "/api/contacts";
    case "kb_articles":
      return "/api/admin/kb-articles";
    case "tasks":
      return "/api/tasks";
    default:
      return "";
  }
}

/**
 * Get database table name for entity
 * @param {string} entityId - Entity identifier
 * @returns {string} Database table name
 */
export function getEntityTableName(entityId) {
  switch (entityId) {
    case "contacts":
      return "contacts";
    case "kb_articles":
      return "kb_articles";
    case "tasks":
      return "tasks";
    default:
      return "";
  }
}

/**
 * Get fields relevant for a specific action
 * @param {string} entityId - Entity identifier
 * @param {string} action - Action type (create, read, update, delete, list)
 * @returns {Object} Filtered schema with only relevant fields
 */
export function getFieldsForAction(entityId, action) {
  const schema = getEntitySchema(entityId);
  const fields = {};

  switch (action) {
    case "create":
      // Include all fields except auto-generated ones
      Object.entries(schema).forEach(([fieldName, fieldDef]) => {
        if (!fieldDef.autoGenerate) {
          fields[fieldName] = fieldDef;
        }
      });
      break;
    case "read":
      // No fields needed, only recordId
      break;
    case "update":
      // Include all fields except auto-generated ones (partial update)
      Object.entries(schema).forEach(([fieldName, fieldDef]) => {
        if (!fieldDef.autoGenerate) {
          fields[fieldName] = { ...fieldDef, required: false }; // All optional for update
        }
      });
      break;
    case "delete":
      // No fields needed, only recordId
      break;
    case "list":
      // Return query parameter fields based on entity
      if (entityId === "contacts") {
        return {
          q: { type: "string", required: false, description: "Search query" },
          phone: {
            type: "string",
            required: false,
            description: "Filter by phone number",
          },
          email: {
            type: "string",
            required: false,
            description: "Filter by email",
          },
          company: {
            type: "string",
            required: false,
            description: "Filter by company name",
          },
          page: {
            type: "number",
            required: false,
            description: "Page number",
          },
          pageSize: {
            type: "number",
            required: false,
            description: "Page size",
          },
        };
      } else if (entityId === "kb_articles") {
        return {
          q: { type: "string", required: false, description: "Search query" },
          status: {
            type: "string",
            required: false,
            description: "Filter by status",
          },
          category: {
            type: "string",
            required: false,
            description: "Filter by category",
          },
          page: {
            type: "number",
            required: false,
            description: "Page number",
          },
          pageSize: {
            type: "number",
            required: false,
            description: "Page size",
          },
        };
      } else if (entityId === "tasks") {
        return {
          q: { type: "string", required: false, description: "Search query" },
          status: {
            type: "string",
            required: false,
            description: "Filter by status",
          },
          task_type: {
            type: "string",
            required: false,
            description: "Filter by task type",
          },
          priority: {
            type: "string",
            required: false,
            description: "Filter by priority",
          },
          assigned_to: {
            type: "string",
            required: false,
            description: "Filter by assigned user ID",
          },
          page: {
            type: "number",
            required: false,
            description: "Page number",
          },
          pageSize: {
            type: "number",
            required: false,
            description: "Page size",
          },
        };
      }
      break;
  }

  return fields;
}
