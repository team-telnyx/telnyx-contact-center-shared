import {
  getEntityBasePath,
  getEntitySchema,
  getEntityTableName,
} from "../lib/data-sources-schema.js";

const DATA_SOURCE_DEFINITIONS = [
  {
    id: "contacts",
    label: "Contacts",
    dynamicVariables: [
      "contact_id",
      "first_name",
      "last_name",
      "full_name",
      "display_name",
      "company_name",
      "job_title",
      "department",
      "phone",
      "mobile",
      "email_address_1",
      "email_address_2",
      "address_street",
      "address_city",
      "address_state",
      "address_zip",
      "address_country",
      "notes",
    ],
  },
  { id: "kb_articles", label: "KB Articles" },
  { id: "tasks", label: "Tasks" },
];

export const CONTACT_CENTER_DATA_SOURCES = DATA_SOURCE_DEFINITIONS.map(
  ({ id, label, dynamicVariables = [] }) => ({
    id,
    label,
    basePath: getEntityBasePath(id),
    tableName: getEntityTableName(id),
    schema: getEntitySchema(id),
    dynamicVariables,
  })
);

const CRUD_ACTIONS = [
  {
    id: "get_single",
    label: "Get single record",
    method: "GET",
    urlPattern: "{basePath}/{id}",
    pathParams: ["id"],
    queryParams: [],
    bodyParams: [],
    description: "Get a single {entity}",
  },
  {
    id: "search",
    label: "Search records",
    method: "GET",
    urlPattern: "{basePath}",
    pathParams: [],
    queryParams: ["*"],
    bodyParams: [],
    description: "Search and list {entities}",
  },
  {
    id: "create",
    label: "Create new record",
    method: "POST",
    urlPattern: "{basePath}",
    pathParams: [],
    queryParams: [],
    bodyParams: ["*"],
    description: "Create a new {entity}",
  },
  {
    id: "update",
    label: "Update existing record",
    method: "PATCH",
    urlPattern: "{basePath}/{id}",
    pathParams: ["id"],
    queryParams: [],
    bodyParams: ["*"],
    description: "Update an existing {entity}",
  },
  {
    id: "delete_single",
    label: "Delete single record",
    method: "DELETE",
    urlPattern: "{basePath}/{id}",
    pathParams: ["id"],
    queryParams: [],
    bodyParams: [],
    description: "Delete a single {entity}",
  },
];

export function getContactCenterDataSourceActions(entityId) {
  if (!CONTACT_CENTER_DATA_SOURCES.some((entity) => entity.id === entityId)) {
    return [];
  }
  if (entityId === "kb_articles") {
    return CRUD_ACTIONS.map((action) =>
      action.id === "update" ? { ...action, method: "PUT" } : action
    );
  }
  return CRUD_ACTIONS;
}
