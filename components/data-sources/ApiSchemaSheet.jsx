"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  IconBook,
  IconApi,
  IconTable,
  IconCheck,
  IconX,
  IconSearch,
} from "@tabler/icons-react";

/**
 * API Schema Sheet Component
 * Displays API documentation for a data source entity
 *
 * @param {object} props
 * @param {string} props.entityId - Entity identifier (e.g., "contacts", "kb_articles", "tasks")
 * @param {string} props.basePath - Base API path (e.g., "/api/contacts", "/api/admin/kb-articles")
 * @param {string} props.dbTable - Database table name (e.g., "contacts", "kb_articles", "tasks")
 * @param {boolean} props.open - Whether the sheet is open
 * @param {function} props.onOpenChange - Callback when sheet open state changes
 */
export default function ApiSchemaSheet({
  entityId,
  basePath,
  dbTable,
  open,
  onOpenChange,
}) {
  // Format entity name for display (convert snake_case to Title Case)
  const formatEntityName = (id) => {
    return id
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  const entityName = formatEntityName(entityId);
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  const getMethodColor = (method) => {
    switch (method) {
      case "GET":
        return "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20";
      case "POST":
        return "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20";
      case "PATCH":
        return "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20";
      case "DELETE":
        return "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20";
      default:
        return "bg-gray-500/10 text-gray-700 dark:text-gray-400 border-gray-500/20";
    }
  };

  const getTypeColor = (type) => {
    switch (type) {
      case "string":
        return "bg-purple-500/10 text-purple-700 dark:text-purple-400";
      case "number":
        return "bg-blue-500/10 text-blue-700 dark:text-blue-400";
      case "boolean":
        return "bg-green-500/10 text-green-700 dark:text-green-400";
      case "array":
        return "bg-orange-500/10 text-orange-700 dark:text-orange-400";
      case "object":
        return "bg-pink-500/10 text-pink-700 dark:text-pink-400";
      case "enum":
        return "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400";
      default:
        return "bg-gray-500/10 text-gray-700 dark:text-gray-400";
    }
  };

  // Define schemas for each entity
  const getEntitySchema = () => {
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
  };

  const entitySchema = getEntitySchema();

  // Get query parameters information for each entity
  const getQueryParametersInfo = (entityId) => {
    switch (entityId) {
      case "contacts":
        return [
          {
            name: "q",
            type: "string",
            required: false,
            description:
              "General text search query. Searches across text fields using case-insensitive pattern matching.",
            searches: [
              "first_name",
              "last_name",
              "display_name",
              "company_name",
              "notes",
            ],
            examples: ["?q=John", "?q=Acme Corp", "?q=Customer Service"],
          },
          {
            name: "phone",
            type: "string",
            required: false,
            description:
              "Search for phone numbers. Searches across all phone number fields.",
            searches: [
              "phone",
              "mobile",
              "business_phone_1",
              "business_phone_2",
              "home_phone_1",
              "home_phone_2",
            ],
            examples: ["?phone=+1234567890", "?phone=123456789"],
          },
          {
            name: "email",
            type: "string",
            required: false,
            description: "Search for email addresses.",
            searches: ["email_address_1", "email_address_2"],
            examples: ["?email=john@example.com"],
          },
          {
            name: "company",
            type: "string",
            required: false,
            description: "Search by company name.",
            searches: ["company_name"],
            examples: ["?company=Acme"],
          },
          {
            name: "page",
            type: "number",
            required: false,
            description: "Page number for pagination (default: 1).",
            examples: ["?page=1", "?page=2"],
          },
          {
            name: "pageSize",
            type: "number",
            required: false,
            description: "Number of records per page (default: 20, max: 100).",
            examples: ["?pageSize=20", "?pageSize=50"],
          },
        ];
      case "kb_articles":
        return [
          {
            name: "q",
            type: "string",
            required: false,
            description:
              "General text search query. Searches across article content and metadata.",
            searches: ["title", "summary", "content", "category"],
            examples: [
              "?q=installation",
              "?q=getting started",
              "?q=troubleshooting",
            ],
          },
          {
            name: "status",
            type: "string",
            required: false,
            description: "Filter by publication status.",
            searches: ["status"],
            examples: [
              "?status=Published",
              "?status=Draft",
              "?status=Archived",
            ],
          },
          {
            name: "category",
            type: "string",
            required: false,
            description: "Filter by article category.",
            searches: ["category"],
            examples: ["?category=Technical", "?category=FAQ"],
          },
          {
            name: "page",
            type: "number",
            required: false,
            description: "Page number for pagination (default: 1).",
            examples: ["?page=1"],
          },
          {
            name: "pageSize",
            type: "number",
            required: false,
            description: "Number of records per page (default: 20, max: 100).",
            examples: ["?pageSize=20"],
          },
        ];
      case "tasks":
        return [
          {
            name: "q",
            type: "string",
            required: false,
            description:
              "General text search query. Searches across task title, description, and caller name.",
            searches: ["title", "description", "caller_name"],
            examples: ["?q=complaint", "?q=John Doe", "?q=urgent issue"],
          },
          {
            name: "status",
            type: "string",
            required: false,
            description: "Filter by task status.",
            searches: ["status"],
            examples: [
              "?status=open",
              "?status=in_progress",
              "?status=resolved",
            ],
          },
          {
            name: "task_type",
            type: "string",
            required: false,
            description:
              "Filter by task type (e.g., incident, sales_query, complaint).",
            searches: ["task_type"],
            examples: [
              "?task_type=incident",
              "?task_type=sales_query",
              "?task_type=complaint",
            ],
          },
          {
            name: "priority",
            type: "string",
            required: false,
            description: "Filter by priority level.",
            searches: ["priority"],
            examples: [
              "?priority=high",
              "?priority=urgent",
              "?priority=medium",
            ],
          },
          {
            name: "assigned_to",
            type: "string",
            required: false,
            description: "Filter by assigned user ID.",
            searches: ["assigned_to"],
            examples: ["?assigned_to=user-uuid"],
          },
          {
            name: "contact_id",
            type: "string",
            required: false,
            description: "Filter by linked contact ID.",
            searches: ["contact_id"],
            examples: ["?contact_id=contact-uuid"],
          },
          {
            name: "page",
            type: "number",
            required: false,
            description: "Page number for pagination (default: 1).",
            examples: ["?page=1"],
          },
          {
            name: "pageSize",
            type: "number",
            required: false,
            description: "Number of records per page (default: 20, max: 100).",
            examples: ["?pageSize=20"],
          },
        ];
      default:
        return [];
    }
  };

  const endpoints = [
    {
      id: "get-single",
      method: "GET",
      label: "Get single record",
      description: `Get a single ${entityId.replace(/_/g, " ")}.`,
      urlPattern: `${basePath}/:id`,
      pathParams: ["id"],
    },
    {
      id: "get-all",
      method: "GET",
      label: "Get all records",
      description: `Get all ${entityId.replace(/_/g, " ")}.`,
      urlPattern: `${basePath}?page=1&pageSize=10`,
    },
    {
      id: "search",
      method: "GET",
      label: "Search records",
      description: `Search for ${entityId.replace(/_/g, " ")} by column values.`,
      urlPattern: `${basePath}/search`,
      queryParams: ["*"],
    },
    {
      id: "create",
      method: "POST",
      label: "Create new record",
      description: `Create a new ${entityId.replace(/_/g, " ")}.`,
      urlPattern: basePath,
    },
    {
      id: "update",
      method: "PATCH",
      label: "Update record",
      description: `Update an existing ${entityId.replace(/_/g, " ")}.`,
      urlPattern: `${basePath}/:id`,
      pathParams: ["id"],
    },
    {
      id: "delete",
      method: "DELETE",
      label: "Delete record",
      description: `Delete an existing ${entityId.replace(/_/g, " ")}.`,
      urlPattern: `${basePath}/:id`,
      pathParams: ["id"],
    },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[700px] sm:w-[700px] md:w-[800px] flex flex-col p-0 h-full"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconApi className="size-5" />
            API Schema — {entityName}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6">
          <div className="space-y-6 py-6">
            {/* Base Information */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <IconBook className="size-4" />
                  Base Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    Entity ID
                  </div>
                  <code className="text-sm bg-muted px-2 py-1 rounded">
                    {entityId}
                  </code>
                </div>
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    Base Path
                  </div>
                  <code className="text-sm bg-muted px-2 py-1 rounded break-all">
                    {baseUrl}
                    {basePath}
                  </code>
                </div>
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    Database Table
                  </div>
                  <code className="text-sm bg-muted px-2 py-1 rounded">
                    {dbTable}
                  </code>
                </div>
              </CardContent>
            </Card>

            {/* API Endpoints */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <IconApi className="size-4" />
                  Available Endpoints
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {endpoints.map((action) => {
                  const fullUrl = `${baseUrl}${action.urlPattern}`;

                  return (
                    <div
                      key={action.id}
                      className="border rounded-lg p-4 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 space-y-1">
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className={`font-mono text-xs ${getMethodColor(
                                action.method,
                              )}`}
                            >
                              {action.method}
                            </Badge>
                            <span className="font-medium">{action.label}</span>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {action.description}
                          </p>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">
                          Endpoint URL
                        </div>
                        <code className="text-xs bg-muted px-3 py-2 rounded block break-all">
                          {fullUrl}
                        </code>
                      </div>

                      {/* Path Parameters */}
                      {action.pathParams && action.pathParams.length > 0 && (
                        <div className="space-y-2">
                          <div className="text-xs font-medium text-muted-foreground">
                            Path Parameters
                          </div>
                          <div className="space-y-1.5">
                            {action.pathParams.map((param) => (
                              <div
                                key={param}
                                className="flex items-center gap-2 text-sm"
                              >
                                <Badge
                                  variant="outline"
                                  className="text-xs font-mono"
                                >
                                  {param}
                                </Badge>
                                <span className="text-muted-foreground">
                                  - string
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Query Parameters */}
                      {action.queryParams && action.queryParams.length > 0 && (
                        <div className="space-y-2">
                          <div className="text-xs font-medium text-muted-foreground">
                            Query Parameters
                          </div>
                          {action.queryParams[0] === "*" ? (
                            <div className="text-sm text-muted-foreground">
                              All entity fields are available as query
                              parameters for filtering
                            </div>
                          ) : (
                            <div className="space-y-1.5">
                              {action.queryParams.map((param) => (
                                <div
                                  key={param}
                                  className="flex items-center gap-2 text-sm"
                                >
                                  <Badge
                                    variant="outline"
                                    className="text-xs font-mono"
                                  >
                                    {param}
                                  </Badge>
                                  <span className="text-muted-foreground">
                                    - string (optional)
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {/* Data Schema */}
            {Object.keys(entitySchema).length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <IconTable className="size-4" />
                    Data Schema
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {Object.entries(entitySchema).map(([fieldName, fieldDef]) => (
                    <div
                      key={fieldName}
                      className="border rounded-lg p-3 space-y-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <code className="text-sm font-semibold">
                              {fieldName}
                            </code>
                            <Badge
                              variant="outline"
                              className={`text-xs ${getTypeColor(
                                fieldDef.type,
                              )}`}
                            >
                              {fieldDef.type}
                            </Badge>
                            {fieldDef.required ? (
                              <Badge
                                variant="outline"
                                className="text-xs bg-red-500/10 text-red-700 dark:text-red-400"
                              >
                                <IconCheck className="size-3 mr-1" />
                                Required
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-xs bg-gray-500/10 text-gray-700 dark:text-gray-400"
                              >
                                <IconX className="size-3 mr-1" />
                                Optional
                              </Badge>
                            )}
                            {fieldDef.autoGenerate && (
                              <Badge
                                variant="outline"
                                className="text-xs bg-blue-500/10 text-blue-700 dark:text-blue-400"
                              >
                                Auto-generated
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground mt-1.5">
                            {fieldDef.description}
                          </p>
                          {fieldDef.enum && Array.isArray(fieldDef.enum) && (
                            <div className="mt-2">
                              <div className="text-xs font-medium text-muted-foreground mb-1">
                                Allowed values:
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {fieldDef.enum.map((value) => (
                                  <Badge
                                    key={value}
                                    variant="outline"
                                    className="text-xs"
                                  >
                                    {value}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Query Parameters */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <IconSearch className="size-4" />
                  Query Parameters
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {getQueryParametersInfo(entityId).map((param) => (
                  <div
                    key={param.name}
                    className="border rounded-lg p-3 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <code className="text-sm font-semibold">
                            {param.name}
                          </code>
                          <Badge
                            variant="outline"
                            className={`text-xs ${getTypeColor(param.type)}`}
                          >
                            {param.type}
                          </Badge>
                          {param.required ? (
                            <Badge
                              variant="outline"
                              className="text-xs bg-red-500/10 text-red-700 dark:text-red-400"
                            >
                              <IconCheck className="size-3 mr-1" />
                              Required
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-xs bg-gray-500/10 text-gray-700 dark:text-gray-400"
                            >
                              <IconX className="size-3 mr-1" />
                              Optional
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mt-1.5">
                          {param.description}
                        </p>
                        {param.searches && (
                          <div className="mt-2">
                            <div className="text-xs font-medium text-muted-foreground mb-1">
                              Searches in fields:
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {param.searches.map((field) => (
                                <Badge
                                  key={field}
                                  variant="outline"
                                  className="text-xs"
                                >
                                  {field}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {param.examples && param.examples.length > 0 && (
                          <div className="mt-2">
                            <div className="text-xs font-medium text-muted-foreground mb-1">
                              Examples:
                            </div>
                            <div className="space-y-1">
                              {param.examples.map((example, idx) => (
                                <code
                                  key={idx}
                                  className="text-xs bg-muted px-2 py-1 rounded block"
                                >
                                  {example}
                                </code>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Authentication */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Authentication</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    API Key (Optional)
                  </div>
                  <code className="text-sm bg-muted px-2 py-1 rounded">
                    telnyx-ai-api-key
                  </code>
                  <p className="text-xs text-muted-foreground mt-1">
                    Optional header for API key authentication
                  </p>
                </div>
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    Session
                  </div>
                  <p className="text-sm text-muted-foreground">
                    All endpoints require an authenticated user session. Admin
                    role is required for most operations. The{" "}
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      created_by
                    </code>{" "}
                    field is automatically populated from the session when
                    creating records.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Response Format */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Response Format</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-2">
                    Success Response (200/201)
                  </div>
                  <pre className="text-xs bg-muted p-3 rounded overflow-x-auto">
                    {entityId === "kb_articles"
                      ? JSON.stringify(
                          {
                            items: [{ id: "...", title: "..." }],
                            total: 0,
                            page: 1,
                            pageSize: 10,
                          },
                          null,
                          2,
                        )
                      : entityId === "contacts" || entityId === "tasks"
                        ? JSON.stringify(
                            {
                              rows: [
                                {
                                  id: "...",
                                  ...Object.keys(entitySchema)
                                    .slice(0, 2)
                                    .reduce((acc, key) => {
                                      acc[key] = "...";
                                      return acc;
                                    }, {}),
                                },
                              ],
                              count: 0,
                            },
                            null,
                            2,
                          )
                        : JSON.stringify(
                            {
                              ok: true,
                              id: "...",
                              data: {
                                ...Object.keys(entitySchema)
                                  .slice(0, 3)
                                  .reduce((acc, key) => {
                                    acc[key] = "...";
                                    return acc;
                                  }, {}),
                              },
                            },
                            null,
                            2,
                          )}
                  </pre>
                </div>
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-2">
                    Error Response (4xx/5xx)
                  </div>
                  <pre className="text-xs bg-muted p-3 rounded overflow-x-auto">
                    {JSON.stringify(
                      {
                        error: "Error message",
                      },
                      null,
                      2,
                    )}
                  </pre>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
