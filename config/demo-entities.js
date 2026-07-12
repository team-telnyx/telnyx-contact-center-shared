/**
 * Configuration for Demo Data entities and their API actions
 * Used for automated webhook tool configuration in AI Assistants
 */

export const DEMO_ENTITIES = [
  {
    id: "customers",
    label: "Customers",
    basePath: "/api/data/customers",
    tableName: "demo_customers",
    schema: {
      first_name: {
        type: "string",
        required: true,
        description: "First name provided by the customer",
      },
      last_name: {
        type: "string",
        required: true,
        description: "Last name provided by the customer",
      },
      customer_id: {
        type: "string",
        required: true,
        description: "Customer ID for verification purposes (6 digits)",
      },
      passphrase: {
        type: "string",
        required: true,
        description: "Passphrase for customer verification (4 digits)",
      },
      address: {
        type: "string",
        required: false,
        description: "Customer's street address",
      },
      phone: {
        type: "string",
        required: false,
        description: "Customer's primary phone number in E.164 format",
      },
      mobile: {
        type: "string",
        required: false,
        description: "Customer's mobile phone number",
      },
      business_phone_1: {
        type: "string",
        required: false,
        description: "Customer's first business phone number",
      },
      business_phone_2: {
        type: "string",
        required: false,
        description: "Customer's second business phone number",
      },
      home_phone_1: {
        type: "string",
        required: false,
        description: "Customer's first home phone number",
      },
      home_phone_2: {
        type: "string",
        required: false,
        description: "Customer's second home phone number",
      },
      sip_uri: {
        type: "string",
        required: false,
        description: "Customer's SIP URI for VoIP calls",
      },
      email: {
        type: "string",
        required: false,
        description: "Customer's email address",
      },
      notes: {
        type: "string",
        required: false,
        description: "Additional notes about the customer",
      },
      custom_data: {
        type: "object",
        required: false,
        description: "Custom data fields as key-value pairs",
      },
      active: {
        type: "boolean",
        required: false,
        description: "Whether the customer is active (default: true)",
      },
    },
  },
  {
    id: "appointments",
    label: "Appointments",
    basePath: "/api/data/appointments",
    tableName: "demo_appointments",
    schema: {
      customer_id: {
        type: "string",
        required: true,
        description: "ID of the patient who scheduled the appointment",
      },
      name: {
        type: "string",
        required: true,
        description: "Customer name for the appointment",
      },
      purpose: {
        type: "string",
        required: true,
        description: "The purpose or reason for the appointment",
      },
      type: {
        type: "string",
        required: true,
        description:
          "Type of appointment (webinar, call, on site, doctor visit)",
      },
      appointment_date: {
        type: "string",
        required: true,
        description:
          "Date and time of the appointment in ISO 8601 format (UTC)",
      },
      status: {
        type: "enum",
        required: true,
        description: "Current status of the appointment",
        enum: ["booked", "confirmed", "cancelled"],
      },
      notes: {
        type: "string",
        required: false,
        description: "Additional notes about the appointment",
      },
      custom_data: {
        type: "object",
        required: false,
        description: "Custom data fields as key-value pairs",
      },
    },
  },
  {
    id: "locations",
    label: "Locations",
    basePath: "/api/data/locations",
    tableName: "demo_locations",
    schema: {
      street: {
        type: "string",
        required: true,
        description: "Street name and number",
      },
      name: {
        type: "string",
        required: true,
        description: "Facility or location display name",
      },
      city: { type: "string", required: true, description: "City name" },
      zip_code: {
        type: "string",
        required: true,
        description: "Postal or ZIP code",
      },
      country: {
        type: "string",
        required: true,
        description: "Country name or ISO code",
      },
      type: {
        type: "enum",
        required: true,
        description: "Location type (medical facility, hotel, office, etc.)",
        enum: [
          "Hotel",
          "Office",
          "Home",
          "Medical Centre",
          "Restaurant",
          "Retail Store",
          "Warehouse",
          "Conference Center",
          "Co-working Space",
          "Airport",
          "Beauty Salon",
          "Train Station",
          "Stadium",
          "Theater",
          "Cinema",
          "Museum",
          "Bank",
          "Pharmacy",
          "Fitness Center",
          "Car Service",
          "Spa",
        ],
      },
      notes: {
        type: "string",
        required: false,
        description: "Additional notes about the location",
      },
    },
  },
  {
    id: "calendars",
    label: "Calendars",
    basePath: "/api/data/calendars",
    tableName: "demo_calendars",
    schema: {
      date: {
        type: "string",
        required: true,
        description: "Date in YYYY-MM-DD format",
      },
      start_time: {
        type: "string",
        required: true,
        description: "Start time in HH:mm 24-hour format",
      },
      end_time: {
        type: "string",
        required: true,
        description: "End time in HH:mm 24-hour format",
      },
      location_id: {
        type: "string",
        required: true,
        description: "ID of the location where the slot is booked",
      },
      customer_id: {
        type: "string",
        required: true,
        description: "ID of the customer the slot is reserved for",
      },
      notes: {
        type: "string",
        required: false,
        description: "Additional notes about the calendar slot",
      },
    },
  },
  {
    id: "orders",
    label: "Orders",
    basePath: "/api/data/orders",
    tableName: "demo_orders",
    schema: {
      customer_id: {
        type: "string",
        required: true,
        description: "ID of the customer who placed the order",
      },
      status: {
        type: "string",
        required: true,
        description:
          "Current status of the order, one of New, Confirmed, Sent, Delivered, Closed",
      },
      tracking: {
        type: "string",
        required: false,
        description: "Tracking number or information for the order",
      },
      items: {
        type: "array",
        required: true,
        description:
          "Array of order items with name, description, quantity, and price",
      },
      total: {
        type: "number",
        required: true,
        description: "Total cost of the order",
      },
      notes: {
        type: "string",
        required: false,
        description: "Additional notes about the order",
      },
      delivery_address: {
        type: "string",
        required: false,
        description: "Delivery address for the order",
      },
      delivery_date: {
        type: "string",
        required: false,
        description: "Scheduled delivery date",
      },
      time_window: {
        type: "string",
        required: false,
        description: "Delivery time window (e.g., '9AM-12PM')",
      },
      custom_data: {
        type: "object",
        required: false,
        description: "Custom data fields as key-value pairs",
      },
    },
  },
  {
    id: "patients",
    label: "Patients",
    basePath: "/api/data/patients",
    tableName: "demo_patients",
    schema: {
      first_name: {
        type: "string",
        required: true,
        description: "First name provided by the patient",
      },
      last_name: {
        type: "string",
        required: true,
        description: "Last name provided by the patient",
      },
      patient_id: {
        type: "string",
        required: true,
        description: "Patient ID for authentication (6 digits)",
      },
      passphrase: {
        type: "string",
        required: true,
        description: "Passphrase for patient authentication (4 digits)",
      },
      address: {
        type: "string",
        required: false,
        description: "Patient's street address",
      },
      phone: {
        type: "string",
        required: false,
        description: "Patient's primary phone number in E.164 format",
      },
      mobile: {
        type: "string",
        required: false,
        description: "Patient's mobile phone number",
      },
      business_phone_1: {
        type: "string",
        required: false,
        description: "Patient's first business phone number",
      },
      business_phone_2: {
        type: "string",
        required: false,
        description: "Patient's second business phone number",
      },
      home_phone_1: {
        type: "string",
        required: false,
        description: "Patient's first home phone number",
      },
      home_phone_2: {
        type: "string",
        required: false,
        description: "Patient's second home phone number",
      },
      sip_uri: {
        type: "string",
        required: false,
        description: "Patient's SIP URI for VoIP calls",
      },
      email: {
        type: "string",
        required: false,
        description: "Patient's email address",
      },
      dob: {
        type: "string",
        required: false,
        description: "Patient's date of birth in YYYY-MM-DD format",
      },
      active: {
        type: "boolean",
        required: false,
        description: "Whether the patient is active (default: true)",
      },
      notes: {
        type: "string",
        required: false,
        description: "Additional notes about the patient",
      },
      custom_data: {
        type: "object",
        required: false,
        description: "Custom data fields as key-value pairs",
      },
    },
  },
  {
    id: "prescriptions",
    label: "Prescriptions",
    basePath: "/api/data/prescriptions",
    tableName: "demo_prescriptions",
    schema: {
      patient_id: {
        type: "string",
        required: true,
        description: "ID of the patient receiving the prescription",
      },
      medications: {
        type: "array",
        required: true,
        fullWidth: true,
        description:
          "Array of medications with name, dosage, frequency, duration, and instructions",
      },
      status: {
        type: "string",
        required: true,
        description: "Current status of the prescription",
      },
      notes: {
        type: "string",
        required: false,
        description: "Additional notes about the prescription",
      },
      custom_data: {
        type: "object",
        required: false,
        description: "Custom data fields as key-value pairs",
      },
    },
  },
  {
    id: "bookings",
    label: "Bookings",
    basePath: "/api/data/bookings",
    tableName: "demo_bookings",
    schema: {
      name: {
        type: "string",
        required: true,
        description: "Name or title of the booking",
      },
      location_id: {
        type: "string",
        required: false,
        description: "ID of the location for the booking",
      },
      customer_id: {
        type: "string",
        required: true,
        description: "ID of the customer who made the reservation",
      },
      rooms: {
        type: "number",
        required: true,
        description: "Number of rooms reserved",
      },
      guests: {
        type: "number",
        required: true,
        description: "Number of guests",
      },
      price: {
        type: "number",
        required: true,
        description: "Price per unit for the booking",
      },
      total: {
        type: "number",
        required: true,
        description: "Total cost of the booking",
      },
      date_from: {
        type: "string",
        required: true,
        description: "Start date of the booking in YYYY-MM-DD format",
      },
      date_to: {
        type: "string",
        required: true,
        description: "End date of the booking in YYYY-MM-DD format",
      },
      status: {
        type: "enum",
        required: true,
        description: "Current status of the booking",
        enum: ["booked", "confirmed", "cancelled"],
      },
      notes: {
        type: "string",
        required: false,
        description: "Additional notes about the booking",
      },
      custom_data: {
        type: "object",
        required: false,
        description: "Custom data fields as key-value pairs",
      },
    },
  },
  {
    id: "invoices",
    label: "Invoices",
    basePath: "/api/data/invoices",
    tableName: "demo_invoices",
    schema: {
      customer_id: {
        type: "string",
        required: true,
        description: "ID of the customer the invoice was issued to",
      },
      status: {
        type: "string",
        required: true,
        description: "Current status of the invoice",
      },
      number: {
        type: "string",
        required: true,
        description: "Invoice number",
      },
      items: {
        type: "array",
        required: true,
        fullWidth: true,
        description:
          "Array of invoice items with name, description, quantity, and price",
      },
      total: {
        type: "number",
        required: true,
        description: "Total amount of the invoice",
      },
      notes: {
        type: "string",
        required: false,
        description: "Additional notes about the invoice",
      },
      custom_data: {
        type: "object",
        required: false,
        description: "Custom data fields as key-value pairs",
      },
    },
  },
  {
    id: "claims",
    label: "Claims",
    basePath: "/api/data/claims",
    tableName: "demo_insurance_claims",
    schema: {
      claim_id: {
        type: "string",
        required: false,
        autoGenerate: true,
        description:
          "Unique claim ticket number (auto-generated in format INC-XXXXX)",
      },
      name: {
        type: "string",
        required: true,
        description: "Name or title of the insurance claim",
      },
      customer_id: {
        type: "string",
        required: true,
        description: "ID of the customer who filed the claim",
      },
      policy_number: {
        type: "string",
        required: true,
        description: "Insurance policy number associated with the claim",
      },
      incident_date: {
        type: "string",
        required: true,
        description: "Date and time of the incident in ISO 8601 format",
      },
      claim_amount: {
        type: "number",
        required: true,
        description: "Amount being claimed",
      },
      amount_approved: {
        type: "number",
        required: false,
        description: "Amount that has been approved",
      },
      claim_status: {
        type: "enum",
        required: true,
        description: "Status of the claim",
        enum: ["Pending", "Approved", "Rejected"],
      },
      description: {
        type: "string",
        required: true,
        description: "Detailed description or notes about the claim",
      },
      notes: {
        type: "string",
        required: false,
        description: "Additional notes about the claim",
      },
      custom_data: {
        type: "object",
        required: false,
        description: "Custom data fields as key-value pairs",
      },
    },
  },
  {
    id: "policies",
    label: "Policies",
    basePath: "/api/data/policies",
    tableName: "demo_insurance_policies",
    schema: {
      name: {
        type: "string",
        required: true,
        description: "Name or title of the insurance policy",
      },
      customer_id: {
        type: "string",
        required: true,
        description: "ID of the customer who owns the policy",
      },
      first_name: {
        type: "string",
        required: true,
        description: "First name of the policyholder",
      },
      last_name: {
        type: "string",
        required: true,
        description: "Last name of the policyholder",
      },
      policy_number: {
        type: "string",
        required: false,
        autoGenerate: true,
        description:
          "Unique policy number (auto-generated in format INS-XXXXX)",
      },
      coverage_type: {
        type: "enum",
        required: true,
        description: "Type of insurance coverage",
        enum: [
          "Health Insurance",
          "Car Insurance",
          "House Insurance",
          "Life Insurance",
          "Travel Insurance",
          "Dental Insurance",
          "Pet Insurance",
          "Business Insurance",
          "Liability Insurance",
          "Accident Insurance",
        ],
      },
      coverage_amount: {
        type: "number",
        required: true,
        description: "Amount covered by the policy",
      },
      start_date: {
        type: "string",
        required: true,
        description: "Policy start date in YYYY-MM-DD format",
      },
      end_date: {
        type: "string",
        required: true,
        description: "Policy end date in YYYY-MM-DD format",
      },
      status: {
        type: "enum",
        required: true,
        description: "Status of the policy",
        enum: ["Active", "Cancelled", "Expired", "In Review"],
      },
      description: {
        type: "string",
        required: false,
        description: "Additional description of the policy",
      },
      notes: {
        type: "string",
        required: false,
        description: "Additional notes about the policy",
      },
      custom_data: {
        type: "object",
        required: false,
        description: "Custom data fields as key-value pairs",
      },
    },
  },
  {
    id: "leads",
    label: "Leads",
    basePath: "/api/data/leads",
    tableName: "demo_leads",
    schema: {
      lead_name: {
        type: "string",
        required: true,
        description: "Name of the sales lead",
      },
      company_name: {
        type: "string",
        required: true,
        description: "Company name associated with the lead",
      },
      email: {
        type: "string",
        required: false,
        description: "Email address of the lead",
      },
      phone: {
        type: "string",
        required: false,
        description: "Phone number of the lead in E.164 format",
      },
      status: {
        type: "enum",
        required: true,
        description: "Current status of the lead",
        enum: ["New", "Contacted", "Qualified", "Lost"],
      },
      notes: {
        type: "string",
        required: false,
        description: "Additional notes about the lead",
      },
      questions: {
        type: "array",
        required: true,
        fullWidth: true,
        description: "Array of questions with question text, answer, and score",
      },
      total_score: {
        type: "number",
        required: true,
        description: "Total score calculated from all questions",
      },
      custom_data: {
        type: "object",
        required: false,
        description: "Custom data fields as key-value pairs",
      },
    },
  },
  {
    id: "incidents",
    label: "Incidents",
    basePath: "/api/data/incidents",
    tableName: "demo_incidents",
    schema: {
      incident_number: {
        type: "string",
        required: false,
        autoGenerate: true,
        description:
          "Unique incident ticket number (auto-generated in format INC-XXXXX)",
      },
      customer_id: {
        type: "string",
        required: true,
        description: "ID of the customer who reported the incident",
      },
      subject: {
        type: "string",
        required: true,
        description: "Brief subject/title of the incident",
      },
      description: {
        type: "string",
        required: true,
        description: "Detailed description of the issue",
      },
      category: {
        type: "enum",
        required: true,
        enum: [
          "Technical",
          "Billing",
          "Account",
          "General",
          "Product",
          "Software",
          "Hardware",
          "Access Rights",
          "Security",
        ],
        description: "Category of the incident",
      },
      priority: {
        type: "enum",
        required: true,
        enum: ["Low", "Medium", "High", "Critical"],
        description: "Priority level",
      },
      status: {
        type: "enum",
        required: true,
        enum: [
          "New",
          "Open",
          "In Progress",
          "Pending Customer",
          "Resolved",
          "Closed",
        ],
        description: "Current status",
      },
      assigned_to: {
        type: "string",
        required: false,
        description: "Agent or team assigned to handle",
      },
      resolution_notes: {
        type: "string",
        required: false,
        description: "Notes on how the issue was resolved",
      },
      resolved_at: {
        type: "string",
        required: false,
        description: "Date and time when resolved (ISO 8601)",
      },
      tags: {
        type: "array",
        required: false,
        description: "Array of tags for categorization",
      },
      related_kb_articles: {
        type: "array",
        required: false,
        description: "Array of related KB article IDs",
      },
      escalated: {
        type: "boolean",
        required: false,
        description: "Whether the ticket was escalated",
      },
      custom_data: {
        type: "object",
        required: false,
        description: "Custom data fields as key-value pairs",
      },
    },
  },
  {
    id: "kb_articles",
    label: "KB Articles",
    basePath: "/api/data/kb-articles",
    tableName: "demo_kb_articles",
    schema: {
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
        description: "Full content of the article (markdown or HTML)",
      },
      category: {
        type: "string",
        required: true,
        description: "Primary category",
      },
      subcategory: {
        type: "string",
        required: false,
        description: "Subcategory for further organization",
      },
      tags: {
        type: "array",
        required: false,
        description: "Array of tags for search and categorization",
      },
      keywords: {
        type: "array",
        required: false,
        description: "Array of keywords for enhanced search",
      },
      author_name: {
        type: "string",
        required: false,
        description: "Name of the article author",
      },
      status: {
        type: "string",
        required: true,
        description: "One of Draft, Published, or Archived",
      },
      language: {
        type: "string",
        required: false,
        description: "Language code (e.g., 'en', 'es')",
      },
      related_articles: {
        type: "array",
        required: false,
        description: "Array of related article IDs",
      },
      related_incident_categories: {
        type: "array",
        required: false,
        description: "Incident categories this article addresses",
      },
      published_at: {
        type: "string",
        required: false,
        description: "Publication date (ISO 8601)",
      },
      last_reviewed_at: {
        type: "string",
        required: false,
        description: "Last review date (ISO 8601)",
      },
      custom_data: {
        type: "object",
        required: false,
        description: "Custom data fields as key-value pairs",
      },
    },
  },
];

// Entity list for tabs and navigation
export const ENTITY_LIST = [
  { key: "customers", label: "Customers" },
  { key: "patients", label: "Patients" },
  { key: "orders", label: "Orders" },
  { key: "invoices", label: "Invoices" },
  { key: "prescriptions", label: "Prescriptions" },
  { key: "bookings", label: "Bookings" },
  { key: "appointments", label: "Appointments" },
  { key: "claims", label: "Claims" },
  { key: "policies", label: "Policies" },
  { key: "leads", label: "Leads" },
  { key: "locations", label: "Locations" },
  { key: "calendars", label: "Calendars" },
  { key: "incidents", label: "Incidents" },
  { key: "kb_articles", label: "KB Articles" },
];

// Display columns for each entity (used in table headers)
export const ENTITY_COLUMNS = {
  customers: ["customer_id", "first_name", "last_name", "address", "phone"],
  patients: ["patient_id", "first_name", "last_name", "address", "phone"],
  orders: [
    "order_id",
    "customer_id",
    "order_date",
    "status",
    "total_amount",
    "currency",
    "shipping_address",
    "tracking_number",
  ],
  invoices: ["number", "customer_id", "status", "total", "notes"],
  prescriptions: ["patient_id", "status", "notes"],
  bookings: [
    "name",
    "customer_id",
    "location_id",
    "date_from",
    "date_to",
    "status",
    "total",
  ],
  appointments: [
    "customer_id",
    "name",
    "type",
    "appointment_date",
    "status",
    "notes",
  ],
  claims: [
    "claim_id",
    "name",
    "policy_number",
    "customer_name",
    "claim_amount",
    "claim_status",
    "incident_date",
  ],
  policies: [
    "policy_id",
    "policy_number",
    "customer_id",
    "policy_type",
    "start_date",
    "end_date",
    "premium",
    "coverage_amount",
  ],
  leads: [
    "lead_name",
    "company_name",
    "email",
    "phone",
    "status",
    "total_score",
    "notes",
  ],
  locations: ["name", "street", "city", "zip_code", "country", "type"],
  calendars: [
    "date",
    "start_time",
    "end_time",
    "duration",
    "location_name",
    "customer_name",
  ],
  incidents: [
    "incident_number",
    "subject",
    "category",
    "priority",
    "status",
    "assigned_to",
  ],
  kb_articles: [
    "title",
    "category",
    "status",
    "view_count",
    "helpful_count",
    "published_at",
  ],
};

// Badge color configurations
export const BADGE_VARIANTS = {
  priority: {
    Low: "default",
    Medium: "secondary",
    High: "destructive",
    Critical: "destructive",
  },
  status: {
    New: "default",
    Open: "secondary",
    "In Progress": "default",
    "Pending Customer": "secondary",
    Resolved: "outline",
    Closed: "outline",
    Draft: "secondary",
    Published: "default",
    Archived: "outline",
  },
  category: {
    Technical: "default",
    Billing: "secondary",
    Account: "default",
    General: "secondary",
    Product: "default",
  },
};

export const BADGE_COLORS = {
  priority: {
    Low: "border-blue-500 text-blue-700 dark:text-blue-400",
    Medium: "border-yellow-500 text-yellow-700 dark:text-yellow-400",
    High: "border-orange-500 text-orange-700 dark:text-orange-400",
    Critical: "border-red-500 text-red-700 dark:text-red-400",
  },
  status: {
    New: "border-blue-500 text-blue-700 dark:text-blue-400",
    Open: "border-cyan-500 text-cyan-700 dark:text-cyan-400",
    "In Progress": "border-purple-500 text-purple-700 dark:text-purple-400",
    "Pending Customer": "border-amber-500 text-amber-700 dark:text-amber-400",
    Resolved: "border-green-500 text-green-700 dark:text-green-400",
    Closed: "border-gray-500 text-gray-700 dark:text-gray-400",
    Draft: "border-gray-500 text-gray-700 dark:text-gray-400",
    Published: "border-green-500 text-green-700 dark:text-green-400",
    Archived: "border-orange-500 text-orange-700 dark:text-orange-400",
  },
  category: {
    Technical: "border-indigo-500 text-indigo-700 dark:text-indigo-400",
    Billing: "border-emerald-500 text-emerald-700 dark:text-emerald-400",
    Account: "border-violet-500 text-violet-700 dark:text-violet-400",
    General: "border-slate-500 text-slate-700 dark:text-slate-400",
    Product: "border-teal-500 text-teal-700 dark:text-teal-400",
    "Software Issues": "border-blue-500 text-blue-700 dark:text-blue-400",
    "Hardware Issues": "border-red-500 text-red-700 dark:text-red-400",
    "Access Rights & Permissions":
      "border-purple-500 text-purple-700 dark:text-purple-400",
    "Password & Security": "border-pink-500 text-pink-700 dark:text-pink-400",
    "Network & Connectivity":
      "border-orange-500 text-orange-700 dark:text-orange-400",
  },
};

// KB Article categories
export const KB_CATEGORIES = [
  "Software Issues",
  "Hardware Issues",
  "Access Rights & Permissions",
  "Password & Security",
  "Network & Connectivity",
];

// KB Article statuses
export const KB_STATUSES = ["Draft", "Published", "Archived"];

// Telnyx API specific actions
export const TELNYX_API_ACTIONS = [
  {
    id: "send_sms",
    label: "Send SMS",
    description: "Messaging - Send SMS",
  },
  {
    id: "recording_start",
    label: "Start Recording",
    description: "Voice API - Start Recording",
  },
  {
    id: "recording_stop",
    label: "Stop Recording",
    description: "Voice API - Stop Recording",
  },
];

// Third Party API specific actions
export const THIRD_PARTY_API_ACTIONS = [
  {
    id: "google_address_validation",
    label: "Google Address Validation",
    description: "Google API - Validate Address",
  },
  {
    id: "expo_push_notification",
    label: "Expo Push Notification",
    description: "Expo API - Send Push Notification",
  },
];

export const DEMO_ACTIONS = [
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
    id: "get_all",
    label: "Get all records",
    method: "GET",
    urlPattern: "{basePath}",
    pathParams: [],
    queryParams: [],
    bodyParams: [],
    description: "Get all {entities}",
  },
  {
    id: "search",
    label: "Search records",
    method: "GET",
    urlPattern: "{basePath}/search",
    pathParams: [],
    queryParams: ["*"], // "*" = generate from entity schema fields
    bodyParams: [],
    description: "Search for {entities} by column values",
  },
  {
    id: "create",
    label: "Create new record",
    method: "POST",
    urlPattern: "{basePath}",
    pathParams: [],
    queryParams: [],
    bodyParams: ["*"], // All fields from entity schema
    description: "Create a new {entity}",
  },
  {
    id: "update",
    label: "Update existing record",
    method: "PATCH",
    urlPattern: "{basePath}/{id}",
    pathParams: ["id"],
    queryParams: [],
    bodyParams: ["*"], // Partial update
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

// KB Articles specific actions (extending DEMO_ACTIONS)
export const KB_ARTICLES_ACTIONS = [
  ...DEMO_ACTIONS,
  {
    id: "semantic_search",
    label: "Semantic Search",
    method: "GET",
    urlPattern: "{basePath}/search",
    pathParams: [],
    queryParams: ["q", "status", "category"],
    bodyParams: [],
    description: "Perform full-text semantic search on KB articles.",
    entitySpecific: true, // Only for kb_articles
  },
];

/**
 * Generate Telnyx API specific webhook configuration
 */
export function generateTelnyxApiWebhookConfig(actionId) {
  // Note: Client-side version - use server-side API endpoint for actual config
  // This is kept for reference but the server-side version uses TELNYX_MESSAGING_PROFILE_ID env var
  const configs = {
    send_sms: {
      name: "sms_send",
      description: "Send an SMS message via Telnyx Messaging API",
      url: "https://api.telnyx.com/v2/messages",
      method: "POST",
      headers: [
        {
          name: "Authorization",
          value:
            "Bearer {{#integration_secret}}telnyx_api_key{{/integration_secret}}",
        },
      ],
      body_parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Use {{telnyx_end_user_target}}",
          },
          from: {
            type: "string",
            description: "Always use Telnyx",
          },
          messaging_profile_id: {
            type: "string",
            description:
              "Messaging profile ID (configured via TELNYX_MESSAGING_PROFILE_ID env variable)",
          },
          text: {
            type: "string",
            description: "Body of the message",
          },
        },
        required: ["to", "from", "messaging_profile_id", "text"],
      },
    },
    recording_start: {
      name: "recording_start",
      description: "Start recording a call via Telnyx Voice API",
      url: "https://api.telnyx.com/v2/calls/{{call_control_id}}/actions/record_start",
      method: "POST",
      headers: [
        {
          name: "Authorization",
          value:
            "Bearer {{#integration_secret}}telnyx_api_key{{/integration_secret}}",
        },
      ],
      body_parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            description: "Always use wav",
          },
          channels: {
            type: "string",
            description: "Always use dual",
          },
        },
        required: ["format", "channels"],
      },
    },
    recording_stop: {
      name: "recording_stop",
      description: "Stop recording a call via Telnyx Voice API",
      url: "https://api.telnyx.com/v2/calls/{{call_control_id}}/actions/record_stop",
      method: "POST",
      headers: [
        {
          name: "Authorization",
          value:
            "Bearer {{#integration_secret}}telnyx_api_key{{/integration_secret}}",
        },
      ],
    },
  };

  const config = configs[actionId];
  if (!config) return null;

  return {
    type: "webhook",
    webhook: {
      ...config,
      timeout_secs: 30,
    },
  };
}

/**
 * Get available actions for an entity
 */
export function getEntityActions(entityId) {
  if (entityId === "kb_articles") {
    return KB_ARTICLES_ACTIONS;
  }
  if (entityId === "third_party_apis") {
    return THIRD_PARTY_API_ACTIONS;
  }
  return DEMO_ACTIONS;
}

/**
 * Generate webhook configuration for a given entity and action
 */
export function generateWebhookConfig(entityId, actionId) {
  // Handle Telnyx APIs
  if (entityId === "telnyx_apis") {
    return generateTelnyxApiWebhookConfig(actionId);
  }

  const entity = DEMO_ENTITIES.find((e) => e.id === entityId);
  const actions = getEntityActions(entityId);
  const action = actions.find((a) => a.id === actionId);

  if (!entity || !action) return null;

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_BASE_URL ||
    (typeof window !== "undefined" ? window.location.origin : "");

  // Build URL
  let url = action.urlPattern
    .replace("{basePath}", entity.basePath)
    .replace("{id}", "{id}");
  url = `${baseUrl}${url}`;

  // Generate name
  const namePrefix =
    action.method.toLowerCase() === "get" ? "get_" : action.id + "_";
  const name = namePrefix + entity.id;

  // Generate description
  const entitySingular = entity.label.toLowerCase().slice(0, -1); // Remove 's'
  const entityPlural = entity.label.toLowerCase();
  const description = action.description
    .replace("{entity}", entitySingular)
    .replace("{entities}", entityPlural);

  // Build headers with API key
  const headers = [
    {
      name: "telnyx-ai-api-key",
      value: `{{#integration_secret}}${process.env.NEXT_PUBLIC_TELNYX_AI_API_KEY_REF}{{/integration_secret}}`,
    },
  ];

  // Build path parameters
  const path_parameters = {};
  if (action.pathParams.length > 0) {
    const properties = {};
    action.pathParams.forEach((param) => {
      properties[param] = {
        type: "string",
        description: `The ${param} of the ${entitySingular}`,
      };
    });
    path_parameters.type = "object";
    path_parameters.properties = properties;
    path_parameters.required = action.pathParams;
  }

  // Build query parameters
  const query_parameters = {};
  if (action.queryParams.length > 0) {
    const properties = {};

    // Check if we need to generate from schema (when queryParams contains "*")
    // This allows search actions to automatically include all entity-specific fields
    // as query parameters, making them available for filtering in the WebhookToolEditor
    if (action.queryParams[0] === "*" && entity.schema) {
      // For search action, add all searchable fields from entity schema
      Object.entries(entity.schema).forEach(([fieldName, fieldDef]) => {
        // Skip fields that don't make sense as search parameters
        if (
          fieldName === "username" ||
          fieldName === "custom_data" ||
          fieldDef.autoGenerate
        ) {
          return;
        }

        // Use the field definition from the schema
        const propertyDef = {
          type: fieldDef.type === "object" ? "string" : fieldDef.type,
          description: fieldDef.description || `Filter by ${fieldName}`,
        };

        // Add enum values if present
        if (fieldDef.enum && Array.isArray(fieldDef.enum)) {
          propertyDef.enum = fieldDef.enum;
        }

        properties[fieldName] = propertyDef;
      });
    } else {
      // Use predefined query params
      action.queryParams.forEach((param) => {
        if (param === "q") {
          if (action.id === "semantic_search") {
            properties[param] = {
              type: "string",
              description:
                "Max 3-5 words search query based on the reported issue. Must be in English as we are using semantic search.",
            };
          } else {
            properties[param] = {
              type: "string",
              description: "Search query string",
            };
          }
        } else if (param === "status") {
          properties[param] = {
            type: "string",
            description: "Filter by status (Draft, Published, Archived)",
            enum: ["Draft", "Published", "Archived"],
          };
        } else if (param === "category") {
          properties[param] = {
            type: "string",
            description: "Filter by category",
            enum: KB_CATEGORIES,
          };
        } else {
          properties[param] = {
            type: "string",
            description: `${param} parameter`,
          };
        }
      });
    }

    query_parameters.type = "object";
    query_parameters.properties = properties;
    // For semantic search, q is required; for regular search, no required params
    query_parameters.required = action.id === "semantic_search" ? ["q"] : [];
  }

  // Build body parameters using entity schema
  const body_parameters = {};
  if (
    action.bodyParams.length > 0 &&
    action.bodyParams[0] === "*" &&
    entity.schema
  ) {
    const properties = {};
    const required = [];

    // Add username field first (always present and required)
    properties.username = {
      type: "string",
      description:
        "Username of the authenticated user (automatically filled from session)",
    };
    required.push("username");

    // Add all fields from entity schema
    Object.entries(entity.schema).forEach(([fieldName, fieldDef]) => {
      // Skip auto-generated fields (like incident_number)
      if (fieldDef.autoGenerate) {
        return;
      }

      // Special handling for object types: convert to string type
      // because webhook tools don't support object types.
      // The AI will generate JSON string based on description.
      if (fieldDef.type === "object") {
        properties[fieldName] = {
          type: "string",
          description: fieldDef.description,
        };
      } else {
        properties[fieldName] = {
          type: fieldDef.type,
          description: fieldDef.description,
        };

        // Add enum values if present
        if (fieldDef.enum && Array.isArray(fieldDef.enum)) {
          properties[fieldName].enum = fieldDef.enum;
        }
      }

      // Mark as required based on schema
      if (fieldDef.required) {
        required.push(fieldName);
      }
    });

    body_parameters.type = "object";
    body_parameters.properties = properties;
    body_parameters.required = required;
  }

  return {
    type: "webhook",
    webhook: {
      name,
      description,
      url,
      method: action.method,
      headers,
      path_parameters:
        Object.keys(path_parameters).length > 0 ? path_parameters : undefined,
      query_parameters:
        Object.keys(query_parameters).length > 0 ? query_parameters : undefined,
      body_parameters:
        Object.keys(body_parameters).length > 0 ? body_parameters : undefined,
      timeout_secs: 30,
    },
  };
}
