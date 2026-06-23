-- Pronghorn Database Schema — Initial Release Baseline
--
-- This single file is the canonical, idempotent baseline for the Pronghorn
-- PostgreSQL schema. It supersedes the previous 001..008 chain (incl. the two
-- prior 004_* files) and represents the final post-008 state: every table,
-- column, enum value, index, and comment that the application currently
-- depends on, with no transient ADDs or DROPs.
--
-- Notes:
--   * The bootstrap script `init-createdb.sql` is a separate concern (a
--     privileged role grant for the per-project DB isolation feature). It has
--     no numeric prefix on purpose — the API's startup migration runner only
--     applies files matching `^\d+.*\.sql$`, so the grant cannot poison the
--     schema batch. Docker's `docker-entrypoint-initdb.d` runs both files at
--     first container init in lexicographic order.
--   * Every CREATE statement is idempotent so this file is safe to re-run.
--   * Row Level Security is intentionally not declared here — Pronghorn uses
--     application-level token authorization (see `project_tokens` and the
--     `_with_token` RPC pattern); RLS may be introduced in a later migration.

-- ======================================================================
-- EXTENSIONS
-- ======================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ======================================================================
-- SCHEMA: auth (Pronghorn-managed authentication, Supabase-compatible)
-- ----------------------------------------------------------------------
-- The application's auth layer (app/backend/src/routes/auth.ts) reads and
-- writes auth.users and auth.one_time_tokens directly. These tables were
-- previously provided by Supabase's system schema; they are recreated here
-- so a clean (non-Supabase) PostgreSQL deployment is self-contained.
-- ======================================================================
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    email               text NOT NULL UNIQUE,
    encrypted_password  text,
    role                text NOT NULL DEFAULT 'user',
    raw_user_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
    email_verified      boolean NOT NULL DEFAULT false,
    recovery_token      text,
    recovery_sent_at    timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_users_email ON auth.users (email);

CREATE TABLE IF NOT EXISTS auth.one_time_tokens (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token_type  text NOT NULL,
    token_hash  text NOT NULL,
    relates_to  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_ott_user_type ON auth.one_time_tokens (user_id, token_type);
CREATE INDEX IF NOT EXISTS idx_auth_ott_hash ON auth.one_time_tokens (token_hash);


-- ======================================================================
-- SCHEMA: public — Enum types
-- ======================================================================

DO $$ BEGIN
    CREATE TYPE public.aal_level AS ENUM ('aal1', 'aal2', 'aal3');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.app_role AS ENUM ('admin', 'user', 'superadmin');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.audit_severity AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.build_status AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.code_challenge_method AS ENUM ('s256', 'plain');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.database_plan AS ENUM ('free', 'basic_256mb', 'basic_1gb', 'basic_4gb', 'pro_4gb', 'pro_8gb', 'pro_16gb', 'pro_32gb', 'pro_64gb', 'pro_128gb', 'pro_192gb', 'pro_256gb', 'pro_384gb', 'pro_512gb', 'accelerated_16gb', 'accelerated_32gb', 'accelerated_64gb', 'accelerated_128gb', 'accelerated_256gb', 'accelerated_384gb', 'accelerated_512gb', 'accelerated_768gb', 'accelerated_1024gb');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.database_provider AS ENUM ('render_postgres', 'supabase');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.database_status AS ENUM ('pending', 'creating', 'available', 'suspended', 'restarting', 'updating', 'failed', 'deleted');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.deployment_environment AS ENUM ('dev', 'uat', 'prod');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.deployment_platform AS ENUM ('pronghorn_cloud', 'local', 'dedicated_vm');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.deployment_status AS ENUM ('pending', 'building', 'deploying', 'running', 'stopped', 'failed', 'deleted', 'suspended');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.factor_status AS ENUM ('unverified', 'verified');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.factor_type AS ENUM ('totp', 'webauthn');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.node_type AS ENUM ('COMPONENT', 'API', 'DATABASE', 'SERVICE', 'WEBHOOK', 'FIREWALL', 'SECURITY', 'REQUIREMENT', 'STANDARD', 'TECH_STACK', 'PAGE', 'PROJECT', 'WEB_COMPONENT', 'HOOK_COMPOSABLE', 'API_SERVICE', 'API_ROUTER', 'API_MIDDLEWARE', 'API_CONTROLLER', 'API_UTIL', 'EXTERNAL_SERVICE', 'SCHEMA', 'TABLE', 'AGENT', 'OTHER', 'NOTES', 'ZONE', 'LABEL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.one_time_token_type AS ENUM ('confirmation_token', 'reauthentication_token', 'recovery_token', 'email_change_token_new', 'email_change_token_current', 'phone_change_token');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.project_status AS ENUM ('DESIGN', 'AUDIT', 'BUILD');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.project_token_role AS ENUM ('owner', 'editor', 'viewer');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.requirement_type AS ENUM ('EPIC', 'FEATURE', 'STORY', 'ACCEPTANCE_CRITERIA');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.resource_type AS ENUM ('file', 'website', 'youtube', 'image', 'repo', 'library');
EXCEPTION WHEN duplicate_object THEN null;
END $$;


-- ======================================================================
-- SCHEMA: public — Tables
-- ======================================================================

-- Table: public.activity_logs
CREATE TABLE IF NOT EXISTS public.activity_logs (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    type text NOT NULL,
    message text NOT NULL,
    status text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.agent_blackboard
CREATE TABLE IF NOT EXISTS public.agent_blackboard (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    entry_type text NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.agent_file_operations
CREATE TABLE IF NOT EXISTS public.agent_file_operations (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    operation_type text NOT NULL,
    file_path text,
    status text NOT NULL DEFAULT 'pending'::text,
    details jsonb DEFAULT '{}'::jsonb,
    error_message text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    completed_at timestamp with time zone,
    PRIMARY KEY (id)
);

-- Table: public.agent_llm_logs
CREATE TABLE IF NOT EXISTS public.agent_llm_logs (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    project_id uuid NOT NULL,
    iteration integer NOT NULL,
    model text NOT NULL,
    input_prompt text NOT NULL,
    input_char_count integer NOT NULL,
    output_raw text,
    output_char_count integer,
    was_parse_success boolean NOT NULL DEFAULT true,
    parse_error_message text,
    api_response_status integer,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.agent_messages
CREATE TABLE IF NOT EXISTS public.agent_messages (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.agent_session_context
CREATE TABLE IF NOT EXISTS public.agent_session_context (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    context_type text NOT NULL,
    context_data jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.agent_sessions
CREATE TABLE IF NOT EXISTS public.agent_sessions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'running'::text,
    mode text NOT NULL,
    task_description text,
    started_at timestamp with time zone NOT NULL DEFAULT now(),
    completed_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    abort_requested boolean DEFAULT false,
    PRIMARY KEY (id)
);

-- Table: public.artifact_collaboration_blackboard
CREATE TABLE IF NOT EXISTS public.artifact_collaboration_blackboard (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    collaboration_id uuid NOT NULL,
    entry_type text NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.artifact_collaboration_history
CREATE TABLE IF NOT EXISTS public.artifact_collaboration_history (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    collaboration_id uuid NOT NULL,
    version_number integer NOT NULL,
    actor_type text NOT NULL,
    actor_identifier text,
    operation_type text NOT NULL,
    start_line integer NOT NULL,
    end_line integer NOT NULL,
    old_content text,
    new_content text,
    narrative text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.artifact_collaboration_messages
CREATE TABLE IF NOT EXISTS public.artifact_collaboration_messages (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    collaboration_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    token_id uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.artifact_collaborations
CREATE TABLE IF NOT EXISTS public.artifact_collaborations (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    title text,
    status text NOT NULL DEFAULT 'active'::text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    created_by uuid,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    merged_at timestamp with time zone,
    merged_to_artifact boolean DEFAULT false,
    PRIMARY KEY (id)
);

-- Table: public.artifacts
CREATE TABLE IF NOT EXISTS public.artifacts (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    ai_title text,
    ai_summary text,
    source_type text,
    source_id uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    created_by uuid,
    image_url text,
    provenance_id text,
    provenance_path text,
    provenance_page integer,
    provenance_total_pages integer,
    parent_id uuid,
    is_folder boolean DEFAULT false,
    content_length bigint,
    PRIMARY KEY (id)
);

-- Table: public.audit_activity_stream
CREATE TABLE IF NOT EXISTS public.audit_activity_stream (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    agent_role text,
    activity_type text NOT NULL,
    title text NOT NULL,
    content text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.audit_blackboard
CREATE TABLE IF NOT EXISTS public.audit_blackboard (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    iteration integer NOT NULL,
    agent_role text NOT NULL,
    entry_type text NOT NULL,
    content text NOT NULL,
    evidence jsonb DEFAULT '[]'::jsonb,
    confidence double precision,
    target_agent text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.audit_graph_edges
CREATE TABLE IF NOT EXISTS public.audit_graph_edges (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    source_node_id text NOT NULL,
    target_node_id text NOT NULL,
    label text,
    edge_type text NOT NULL DEFAULT 'relates_to'::text,
    weight double precision DEFAULT 1.0,
    created_by_agent text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.audit_graph_nodes
CREATE TABLE IF NOT EXISTS public.audit_graph_nodes (
    id text NOT NULL DEFAULT (gen_random_uuid())::text,
    session_id uuid NOT NULL,
    label text NOT NULL,
    description text,
    node_type text NOT NULL DEFAULT 'concept'::text,
    source_dataset text,
    source_element_ids _text DEFAULT '{}'::uuid[],
    created_by_agent text NOT NULL,
    x_position double precision DEFAULT 0,
    y_position double precision DEFAULT 0,
    color text,
    size integer DEFAULT 10,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.audit_sessions
CREATE TABLE IF NOT EXISTS public.audit_sessions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    status text NOT NULL DEFAULT 'pending'::text,
    dataset_1_type text NOT NULL,
    dataset_1_ids _uuid,
    dataset_2_type text NOT NULL,
    dataset_2_ids _uuid,
    agent_definitions jsonb DEFAULT '[]'::jsonb,
    max_iterations integer NOT NULL DEFAULT 500,
    current_iteration integer NOT NULL DEFAULT 0,
    problem_shape jsonb,
    tesseract_dimensions jsonb,
    venn_result jsonb,
    consensus_votes jsonb DEFAULT '{}'::jsonb,
    consensus_reached boolean DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    completed_at timestamp with time zone,
    created_by uuid,
    phase text DEFAULT 'conference'::text,
    graph_complete_votes jsonb DEFAULT '{}'::jsonb,
    dataset_1_content jsonb,
    dataset_2_content jsonb,
    PRIMARY KEY (id)
);

-- Table: public.audit_tesseract_cells
CREATE TABLE IF NOT EXISTS public.audit_tesseract_cells (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    x_element_id text NOT NULL,
    x_element_type text NOT NULL,
    x_element_label text,
    x_index integer NOT NULL,
    y_step integer NOT NULL,
    y_step_label text,
    z_polarity double precision NOT NULL DEFAULT 0,
    z_criticality text DEFAULT 'info'::text,
    evidence_summary text,
    evidence_refs jsonb DEFAULT '[]'::jsonb,
    contributing_agents _text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.build_book_standards
CREATE TABLE IF NOT EXISTS public.build_book_standards (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    build_book_id uuid NOT NULL,
    standard_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.build_book_tech_stacks
CREATE TABLE IF NOT EXISTS public.build_book_tech_stacks (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    build_book_id uuid NOT NULL,
    tech_stack_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.build_books
CREATE TABLE IF NOT EXISTS public.build_books (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    short_description text,
    long_description text,
    cover_image_url text,
    tags _text DEFAULT '{}'::text[],
    org_id uuid,
    is_published boolean NOT NULL DEFAULT false,
    created_by uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    prompt text,
    deploy_count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (id)
);

-- Table: public.build_sessions
CREATE TABLE IF NOT EXISTS public.build_sessions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    branch text NOT NULL,
    max_epochs integer NOT NULL DEFAULT 10,
    current_epoch integer NOT NULL DEFAULT 0,
    status public.build_status NOT NULL DEFAULT 'RUNNING'::build_status,
    preview_url text,
    started_at timestamp with time zone NOT NULL DEFAULT now(),
    completed_at timestamp with time zone,
    PRIMARY KEY (id)
);

-- Table: public.canvas_edges
CREATE TABLE IF NOT EXISTS public.canvas_edges (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    source uuid NOT NULL,
    target uuid NOT NULL,
    source_handle text,
    target_handle text,
    label text,
    type text DEFAULT 'default'::text,
    edge_type text DEFAULT 'default'::text,
    data jsonb DEFAULT '{}'::jsonb,
    style jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.canvas_layers
CREATE TABLE IF NOT EXISTS public.canvas_layers (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    name text NOT NULL,
    node_ids _text NOT NULL DEFAULT '{}'::text[],
    visible boolean NOT NULL DEFAULT true,
    z_index integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.canvas_node_types
CREATE TABLE IF NOT EXISTS public.canvas_node_types (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    system_name text NOT NULL,
    display_label text NOT NULL,
    description text,
    icon text NOT NULL,
    emoji text,
    color_class text NOT NULL,
    order_score integer NOT NULL,
    category text NOT NULL DEFAULT 'general'::text,
    is_legacy boolean NOT NULL DEFAULT false,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.canvas_nodes
CREATE TABLE IF NOT EXISTS public.canvas_nodes (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    type text NOT NULL DEFAULT 'OTHER',
    position jsonb NOT NULL DEFAULT '{"x": 0, "y": 0}'::jsonb,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    layer_id uuid,
    position_x double precision DEFAULT 0,
    position_y double precision DEFAULT 0,
    width double precision,
    height double precision,
    created_by uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.chat_messages
CREATE TABLE IF NOT EXISTS public.chat_messages (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    chat_session_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    created_by uuid,
    project_id uuid NOT NULL,
    PRIMARY KEY (id)
);

-- Table: public.chat_sessions
CREATE TABLE IF NOT EXISTS public.chat_sessions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    title text,
    ai_title text,
    ai_summary text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    created_by uuid,
    PRIMARY KEY (id)
);

-- Table: public.deployment_issues
CREATE TABLE IF NOT EXISTS public.deployment_issues (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    deployment_id uuid NOT NULL,
    issue_type text NOT NULL DEFAULT 'error'::text,
    message text NOT NULL,
    stack_trace text,
    file_path text,
    line_number integer,
    metadata jsonb DEFAULT '{}'::jsonb,
    resolved boolean DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.deployment_logs
CREATE TABLE IF NOT EXISTS public.deployment_logs (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    deployment_id uuid NOT NULL,
    log_type text NOT NULL DEFAULT 'info'::text,
    message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.github_user_tokens
-- Stores GitHub OAuth user access tokens — replaces PAT-based auth.
CREATE TABLE IF NOT EXISTS public.github_user_tokens (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    access_token text NOT NULL,
    refresh_token text,
    token_expires_at timestamp with time zone,
    github_username text,
    github_user_id text,
    scopes text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.organizations
CREATE TABLE IF NOT EXISTS public.organizations (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.profile_linked_projects
CREATE TABLE IF NOT EXISTS public.profile_linked_projects (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    project_id uuid NOT NULL,
    token uuid NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.profiles
CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    org_id uuid,
    display_name text,
    avatar_url text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    last_login timestamp with time zone,
    email text,
    bio text,
    bio_image_url text,
    language_preference text DEFAULT 'en'::text,
    PRIMARY KEY (id)
);

-- Table: public.project_agents
-- Per-project AI agent configuration used by project agent RPCs.
CREATE TABLE IF NOT EXISTS public.project_agents (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    agent_type text NOT NULL DEFAULT 'coding'::text,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    UNIQUE (project_id, agent_type)
);

-- Table: public.project_database_connections
CREATE TABLE IF NOT EXISTS public.project_database_connections (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    connection_string text NOT NULL,
    host text,
    port integer DEFAULT 5432,
    database_name text,
    ssl_mode text DEFAULT 'require'::text,
    status text NOT NULL DEFAULT 'untested'::text,
    last_connected_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    created_by uuid,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.project_database_sql
CREATE TABLE IF NOT EXISTS public.project_database_sql (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    database_id uuid,
    project_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    sql_content text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    connection_id uuid,
    PRIMARY KEY (id)
);

-- Table: public.project_databases
CREATE TABLE IF NOT EXISTS public.project_databases (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    name text NOT NULL,
    provider public.database_provider NOT NULL DEFAULT 'render_postgres'::database_provider,
    plan public.database_plan NOT NULL DEFAULT 'basic_256mb'::database_plan,
    status public.database_status NOT NULL DEFAULT 'pending'::database_status,
    region text DEFAULT 'oregon'::text,
    postgres_version text DEFAULT '16'::text,
    render_postgres_id text,
    dashboard_url text,
    supabase_project_id text,
    supabase_url text,
    has_connection_info boolean DEFAULT false,
    created_by uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    database_user text,
    database_internal_name text,
    ip_allow_list jsonb DEFAULT '[]'::jsonb,
    PRIMARY KEY (id)
);

-- Table: public.project_deployments
CREATE TABLE IF NOT EXISTS public.project_deployments (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    repo_id uuid,
    name text NOT NULL,
    environment public.deployment_environment NOT NULL DEFAULT 'dev'::deployment_environment,
    platform public.deployment_platform NOT NULL DEFAULT 'pronghorn_cloud'::deployment_platform,
    project_type text NOT NULL DEFAULT 'node'::text,
    run_folder text NOT NULL DEFAULT '/'::text,
    build_folder text NOT NULL DEFAULT 'dist'::text,
    run_command text NOT NULL DEFAULT 'npm run dev'::text,
    build_command text DEFAULT 'npm run build'::text,
    render_service_id text,
    render_deploy_id text,
    url text,
    branch text DEFAULT 'main'::text,
    status public.deployment_status NOT NULL DEFAULT 'pending'::deployment_status,
    last_deployed_at timestamp with time zone,
    secrets jsonb DEFAULT '{}'::jsonb,
    env_vars jsonb DEFAULT '{}'::jsonb,
    created_by uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    disk_enabled boolean DEFAULT false,
    disk_name text,
    disk_mount_path text DEFAULT '/data'::text,
    disk_size_gb integer DEFAULT 1,
    azure_container_app_name text,
    azure_revision_name text,
    azure_resource_group text,
    install_command text DEFAULT 'npm install'::text,
    dockerfile_path text DEFAULT 'Dockerfile'::text,
    workflow_run_id bigint,
    terraform_state_key text,
    dispatched_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    dispatched_at timestamptz,
    dispatched_action text,
    last_failure_cause text,
    workflow_run_url text,
    port integer DEFAULT 80,
    PRIMARY KEY (id)
);

COMMENT ON COLUMN public.project_deployments.port IS 'Container port the app listens on (used as ingress target_port in Azure Container Apps)';
COMMENT ON COLUMN public.project_deployments.azure_container_app_name IS 'Azure Container App name (replaces render_service_id for Azure deployments)';
COMMENT ON COLUMN public.project_deployments.azure_revision_name IS 'Azure Container App revision name (replaces render_deploy_id for Azure deployments)';
COMMENT ON COLUMN public.project_deployments.azure_resource_group IS 'Azure resource group for this deployment';
COMMENT ON COLUMN public.project_deployments.install_command IS 'Install command (e.g., npm install)';
COMMENT ON COLUMN public.project_deployments.workflow_run_id IS 'GitHub Actions workflow run ID for status polling';
COMMENT ON COLUMN public.project_deployments.terraform_state_key IS 'Terraform state file key (e.g., genapp/{app-id}.tfstate)';
COMMENT ON COLUMN public.project_deployments.dispatched_by_user_id IS
  'Pronghorn user who initiated the most recent dispatch. Used by the poller to resolve a GitHub token via resolveGitHubToken. NULL when the user has been deleted; the poller then falls through to the system PAT.';
COMMENT ON COLUMN public.project_deployments.dispatched_at IS
  'Wall-clock timestamp of the most recent workflow dispatch. Anchor for the stall-window check (default 30 min, see spec FR-007 / SC-004).';
COMMENT ON COLUMN public.project_deployments.dispatched_action IS
  'Most recent workflow-dispatch action verb (create | deploy | destroy). Lets the poller distinguish destroy success/failure from deploy outcomes.';
COMMENT ON COLUMN public.project_deployments.last_failure_cause IS
  'Free-text tag describing the most recent failure (e.g., pre-push-failed, dispatch-http-<status>, stall-window-exceeded, workflow-conclusion-failure). Cleared when a new deploy moves the row out of failed.';
COMMENT ON COLUMN public.project_deployments.workflow_run_url IS
  'GitHub Actions run URL captured when a workflow concludes (success or failure). Surfaced in the UI for operator debugging.';

-- Table: public.project_migrations
CREATE TABLE IF NOT EXISTS public.project_migrations (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    database_id uuid,
    project_id uuid NOT NULL,
    sequence_number integer NOT NULL,
    name text,
    sql_content text NOT NULL,
    statement_type text NOT NULL,
    object_type text NOT NULL,
    object_schema text DEFAULT 'public'::text,
    object_name text,
    executed_at timestamp with time zone NOT NULL DEFAULT now(),
    executed_by uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    connection_id uuid,
    PRIMARY KEY (id)
);

-- Table: public.project_presentations
CREATE TABLE IF NOT EXISTS public.project_presentations (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    name text NOT NULL,
    initial_prompt text,
    mode text NOT NULL DEFAULT 'concise'::text,
    target_slides integer DEFAULT 15,
    version integer NOT NULL DEFAULT 1,
    slides jsonb NOT NULL DEFAULT '[]'::jsonb,
    blackboard jsonb NOT NULL DEFAULT '[]'::jsonb,
    cover_image_url text,
    metadata jsonb DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'draft'::text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    created_by uuid,
    PRIMARY KEY (id)
);

-- Table: public.project_repos
CREATE TABLE IF NOT EXISTS public.project_repos (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    organization text NOT NULL,
    repo text NOT NULL,
    branch text NOT NULL DEFAULT 'main'::text,
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    auto_commit boolean DEFAULT false,
    is_prime boolean DEFAULT false,
    PRIMARY KEY (id)
);

-- Table: public.project_specifications
CREATE TABLE IF NOT EXISTS public.project_specifications (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    generated_spec text NOT NULL,
    raw_data jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    agent_id text,
    agent_title text,
    version integer DEFAULT 1,
    is_latest boolean DEFAULT true,
    generated_by_user_id uuid,
    generated_by_token uuid,
    PRIMARY KEY (id)
);

-- Table: public.project_standards
CREATE TABLE IF NOT EXISTS public.project_standards (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    standard_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.project_tech_stacks
CREATE TABLE IF NOT EXISTS public.project_tech_stacks (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    tech_stack_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.project_testing_logs
CREATE TABLE IF NOT EXISTS public.project_testing_logs (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    deployment_id uuid,
    project_id uuid NOT NULL,
    log_type text NOT NULL DEFAULT 'info'::text,
    message text NOT NULL,
    stack_trace text,
    file_path text,
    line_number integer,
    is_resolved boolean DEFAULT false,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.project_tokens
CREATE TABLE IF NOT EXISTS public.project_tokens (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    token uuid NOT NULL DEFAULT gen_random_uuid(),
    role public.project_token_role NOT NULL DEFAULT 'viewer'::project_token_role,
    label text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    created_by uuid,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    PRIMARY KEY (id)
);

-- Table: public.projects
CREATE TABLE IF NOT EXISTS public.projects (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    description text,
    status public.project_status NOT NULL DEFAULT 'DESIGN'::project_status,
    org_id uuid NOT NULL,
    github_repo text,
    github_branch text DEFAULT 'main'::text,
    created_by uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    organization text,
    budget numeric,
    scope text,
    timeline_start date,
    timeline_end date,
    priority text DEFAULT 'medium'::text,
    tags _text,
    splash_image_url text,
    selected_model text DEFAULT 'gemini-2.5-flash'::text,
    max_tokens integer DEFAULT 32768,
    thinking_enabled boolean DEFAULT false,
    thinking_budget integer DEFAULT '-1'::integer,
    PRIMARY KEY (id)
);

-- Table: public.published_projects
CREATE TABLE IF NOT EXISTS public.published_projects (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    image_url text,
    tags _text DEFAULT '{}'::text[],
    category text,
    is_visible boolean NOT NULL DEFAULT true,
    published_by uuid,
    published_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    clone_count integer DEFAULT 0,
    view_count integer DEFAULT 0,
    PRIMARY KEY (id)
);

-- Table: public.repo_commits
CREATE TABLE IF NOT EXISTS public.repo_commits (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    repo_id uuid NOT NULL,
    project_id uuid NOT NULL,
    branch text NOT NULL,
    commit_sha text NOT NULL,
    commit_message text NOT NULL,
    files_changed integer NOT NULL DEFAULT 0,
    committed_by uuid,
    committed_at timestamp with time zone NOT NULL DEFAULT now(),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    parent_commit_id uuid,
    files_metadata jsonb DEFAULT '[]'::jsonb,
    pushed_at timestamp with time zone,
    github_sha text,
    PRIMARY KEY (id)
);

-- Table: public.repo_files
CREATE TABLE IF NOT EXISTS public.repo_files (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    repo_id uuid NOT NULL,
    path text NOT NULL,
    last_commit_sha text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    is_binary boolean NOT NULL DEFAULT false,
    content_length bigint,
    PRIMARY KEY (id)
);

-- Table: public.repo_pats
CREATE TABLE IF NOT EXISTS public.repo_pats (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    repo_id uuid NOT NULL,
    pat text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.repo_staging
CREATE TABLE IF NOT EXISTS public.repo_staging (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    repo_id uuid NOT NULL,
    project_id uuid NOT NULL,
    operation_type text NOT NULL,
    file_path text NOT NULL,
    old_path text,
    created_at timestamp with time zone DEFAULT now(),
    created_by uuid,
    is_binary boolean NOT NULL DEFAULT false,
    content_length bigint,
    PRIMARY KEY (id)
);

-- Table: public.requirement_standards
CREATE TABLE IF NOT EXISTS public.requirement_standards (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    requirement_id uuid NOT NULL,
    standard_id uuid NOT NULL,
    notes text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.requirements
CREATE TABLE IF NOT EXISTS public.requirements (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    parent_id uuid,
    type public.requirement_type NOT NULL,
    title text NOT NULL,
    content text,
    order_index integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    code text,
    PRIMARY KEY (id)
);

-- Table: public.schema_migrations
-- Tracks which migration files have been applied. 
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version text NOT NULL,
    executed_at timestamp with time zone DEFAULT now(),
    PRIMARY KEY (version)
);

-- Table: public.standard_attachments
CREATE TABLE IF NOT EXISTS public.standard_attachments (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    standard_id uuid NOT NULL,
    type text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    description text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.standard_categories
CREATE TABLE IF NOT EXISTS public.standard_categories (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    description text,
    icon text,
    color text,
    order_index integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    org_id uuid,
    created_by uuid,
    is_system boolean DEFAULT false,
    short_description text,
    long_description text,
    PRIMARY KEY (id)
);

-- Table: public.standard_resources
CREATE TABLE IF NOT EXISTS public.standard_resources (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    standard_id uuid,
    standard_category_id uuid,
    resource_type public.resource_type NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    description text,
    thumbnail_url text,
    order_index integer DEFAULT 0,
    created_by uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.standards
CREATE TABLE IF NOT EXISTS public.standards (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    category_id uuid NOT NULL,
    parent_id uuid,
    code text NOT NULL,
    title text NOT NULL,
    description text,
    content text,
    order_index integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    org_id uuid,
    created_by uuid,
    is_system boolean DEFAULT false,
    short_description text,
    long_description text,
    PRIMARY KEY (id)
);

-- Table: public.tech_stack_resources
CREATE TABLE IF NOT EXISTS public.tech_stack_resources (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tech_stack_id uuid NOT NULL,
    resource_type public.resource_type NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    description text,
    thumbnail_url text,
    order_index integer DEFAULT 0,
    created_by uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.tech_stack_standards
CREATE TABLE IF NOT EXISTS public.tech_stack_standards (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tech_stack_id uuid NOT NULL,
    standard_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- Table: public.tech_stacks
CREATE TABLE IF NOT EXISTS public.tech_stacks (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    org_id uuid,
    name text NOT NULL,
    description text,
    icon text,
    color text,
    created_by uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    metadata jsonb DEFAULT '{}'::jsonb,
    parent_id uuid,
    type text,
    order_index integer NOT NULL DEFAULT 0,
    short_description text,
    long_description text,
    version text,
    version_constraint text DEFAULT '^'::text,
    PRIMARY KEY (id)
);

-- Table: public.user_roles
CREATE TABLE IF NOT EXISTS public.user_roles (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    role public.app_role NOT NULL DEFAULT 'user'::app_role,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    created_by uuid,
    PRIMARY KEY (id)
);


-- ======================================================================
-- SCHEMA: public — Indexes
-- ======================================================================

CREATE UNIQUE INDEX IF NOT EXISTS artifact_collaboration_histor_collaboration_id_version_numb_key ON public.artifact_collaboration_history USING btree (collaboration_id, version_number);
CREATE UNIQUE INDEX IF NOT EXISTS audit_tesseract_cells_session_element_step_key ON public.audit_tesseract_cells USING btree (session_id, x_element_id, y_step);
CREATE UNIQUE INDEX IF NOT EXISTS audit_tesseract_cells_session_id_x_element_id_y_step_key ON public.audit_tesseract_cells USING btree (session_id, x_element_id, y_step);
CREATE UNIQUE INDEX IF NOT EXISTS build_book_standards_build_book_id_standard_category_id_key ON public.build_book_standards USING btree (build_book_id, standard_id);
CREATE UNIQUE INDEX IF NOT EXISTS build_book_tech_stacks_build_book_id_tech_stack_id_key ON public.build_book_tech_stacks USING btree (build_book_id, tech_stack_id);
CREATE UNIQUE INDEX IF NOT EXISTS canvas_node_types_system_name_key ON public.canvas_node_types USING btree (system_name);
CREATE UNIQUE INDEX IF NOT EXISTS github_user_tokens_user_id_key ON public.github_user_tokens USING btree (user_id);
CREATE INDEX IF NOT EXISTS github_user_tokens_github_user_id_idx ON public.github_user_tokens USING btree (github_user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_project_id ON public.activity_logs USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_agent_blackboard_created_at ON public.agent_blackboard USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_agent_blackboard_session_id ON public.agent_blackboard USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_agent_file_operations_created_at ON public.agent_file_operations USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_file_operations_session ON public.agent_file_operations USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_agent_llm_logs_project ON public.agent_llm_logs USING btree (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_llm_logs_session ON public.agent_llm_logs USING btree (session_id, iteration);
CREATE INDEX IF NOT EXISTS idx_agent_messages_created_at ON public.agent_messages USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session_id ON public.agent_messages USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_agent_session_context_session_id ON public.agent_session_context USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project_id ON public.agent_sessions USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON public.agent_sessions USING btree (status);
CREATE INDEX IF NOT EXISTS idx_artifact_collaborations_artifact ON public.artifact_collaborations USING btree (artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_collaborations_project ON public.artifact_collaborations USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_artifact_collaborations_status ON public.artifact_collaborations USING btree (status);
CREATE INDEX IF NOT EXISTS idx_artifacts_provenance_id ON public.artifacts USING btree (provenance_id) WHERE (provenance_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_activity_stream_session ON public.audit_activity_stream USING btree (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_blackboard_iteration ON public.audit_blackboard USING btree (session_id, iteration);
CREATE INDEX IF NOT EXISTS idx_audit_blackboard_session ON public.audit_blackboard USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_audit_sessions_project ON public.audit_sessions USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_audit_sessions_status ON public.audit_sessions USING btree (status);
CREATE INDEX IF NOT EXISTS idx_audit_tesseract_element ON public.audit_tesseract_cells USING btree (session_id, x_element_id);
CREATE INDEX IF NOT EXISTS idx_audit_tesseract_session ON public.audit_tesseract_cells USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_build_book_standards_build_book_id ON public.build_book_standards USING btree (build_book_id);
CREATE INDEX IF NOT EXISTS idx_build_book_tech_stacks_build_book_id ON public.build_book_tech_stacks USING btree (build_book_id);
CREATE INDEX IF NOT EXISTS idx_build_books_is_published ON public.build_books USING btree (is_published);
CREATE INDEX IF NOT EXISTS idx_build_books_org_id ON public.build_books USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_build_sessions_project_id ON public.build_sessions USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_canvas_edges_project_id ON public.canvas_edges USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_canvas_nodes_project_id ON public.canvas_nodes USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_project_id ON public.chat_messages USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_collab_blackboard_collaboration ON public.artifact_collaboration_blackboard USING btree (collaboration_id);
CREATE INDEX IF NOT EXISTS idx_collab_history_created ON public.artifact_collaboration_history USING btree (collaboration_id, created_at);
CREATE INDEX IF NOT EXISTS idx_collab_history_version ON public.artifact_collaboration_history USING btree (collaboration_id, version_number);
CREATE INDEX IF NOT EXISTS idx_collab_messages_collaboration ON public.artifact_collaboration_messages USING btree (collaboration_id);
CREATE INDEX IF NOT EXISTS idx_collab_messages_created ON public.artifact_collaboration_messages USING btree (collaboration_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deployment_logs_created_at ON public.deployment_logs USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployment_logs_deployment_id ON public.deployment_logs USING btree (deployment_id);
-- Partial index supporting GitHub Actions workflow status polling.
CREATE INDEX IF NOT EXISTS idx_deployments_workflow_run_id ON public.project_deployments (workflow_run_id) WHERE workflow_run_id IS NOT NULL;
-- Partial index supporting the deployment poller's transitional-row scan.
CREATE INDEX IF NOT EXISTS idx_deployments_in_flight ON public.project_deployments (dispatched_at) WHERE status IN ('pending', 'building', 'deploying');
CREATE INDEX IF NOT EXISTS idx_profiles_org_id ON public.profiles USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON public.profiles USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_project_agents_project_id ON public.project_agents USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_project_database_connections_project_id ON public.project_database_connections USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_project_database_sql_connection_id ON public.project_database_sql USING btree (connection_id);
CREATE INDEX IF NOT EXISTS idx_project_database_sql_database_id ON public.project_database_sql USING btree (database_id);
CREATE INDEX IF NOT EXISTS idx_project_database_sql_project_id ON public.project_database_sql USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_project_deployments_project_id ON public.project_deployments USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_project_deployments_status ON public.project_deployments USING btree (status);
CREATE INDEX IF NOT EXISTS idx_project_migrations_connection_id ON public.project_migrations USING btree (connection_id);
CREATE INDEX IF NOT EXISTS idx_project_migrations_order ON public.project_migrations USING btree (database_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_project_repos_project_id ON public.project_repos USING btree (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_spec_agent_version ON public.project_specifications USING btree (project_id, agent_id, version);
CREATE INDEX IF NOT EXISTS idx_project_spec_latest ON public.project_specifications USING btree (project_id, agent_id, is_latest) WHERE (is_latest = true);
CREATE INDEX IF NOT EXISTS idx_project_standards_project_id ON public.project_standards USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_project_standards_standard_id ON public.project_standards USING btree (standard_id);
CREATE INDEX IF NOT EXISTS idx_project_tech_stacks_project ON public.project_tech_stacks USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_project_tokens_project_id ON public.project_tokens USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_project_tokens_token ON public.project_tokens USING btree (token);
CREATE INDEX IF NOT EXISTS idx_project_presentations_project_id ON public.project_presentations USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_project_presentations_status ON public.project_presentations USING btree (status);
CREATE INDEX IF NOT EXISTS idx_projects_org_id ON public.projects USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_published_projects_category ON public.published_projects USING btree (category);
CREATE INDEX IF NOT EXISTS idx_published_projects_tags ON public.published_projects USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_published_projects_visible ON public.published_projects USING btree (is_visible) WHERE (is_visible = true);
CREATE INDEX IF NOT EXISTS idx_repo_commits_branch ON public.repo_commits USING btree (branch);
CREATE INDEX IF NOT EXISTS idx_repo_commits_parent ON public.repo_commits USING btree (parent_commit_id);
CREATE INDEX IF NOT EXISTS idx_repo_commits_project_id ON public.repo_commits USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_repo_commits_repo_id ON public.repo_commits USING btree (repo_id);
CREATE INDEX IF NOT EXISTS idx_repo_files_content_length ON public.repo_files USING btree (content_length);
CREATE INDEX IF NOT EXISTS idx_repo_files_project_id ON public.repo_files USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_repo_files_repo_id_path ON public.repo_files USING btree (repo_id, path);
CREATE INDEX IF NOT EXISTS idx_repo_staging_content_length ON public.repo_staging USING btree (content_length);
CREATE INDEX IF NOT EXISTS idx_repo_staging_project_id ON public.repo_staging USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_repo_staging_repo_id ON public.repo_staging USING btree (repo_id);
CREATE INDEX IF NOT EXISTS idx_requirement_standards_requirement_id ON public.requirement_standards USING btree (requirement_id);
CREATE INDEX IF NOT EXISTS idx_requirement_standards_standard_id ON public.requirement_standards USING btree (standard_id);
CREATE INDEX IF NOT EXISTS idx_requirements_code ON public.requirements USING btree (code);
CREATE INDEX IF NOT EXISTS idx_requirements_parent_id ON public.requirements USING btree (parent_id);
CREATE INDEX IF NOT EXISTS idx_requirements_project_id ON public.requirements USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_standard_attachments_standard_id ON public.standard_attachments USING btree (standard_id);
CREATE INDEX IF NOT EXISTS idx_standard_categories_org_id ON public.standard_categories USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_standard_resources_category_id ON public.standard_resources USING btree (standard_category_id);
CREATE INDEX IF NOT EXISTS idx_standard_resources_standard_id ON public.standard_resources USING btree (standard_id);
CREATE INDEX IF NOT EXISTS idx_standards_category_id ON public.standards USING btree (category_id);
CREATE INDEX IF NOT EXISTS idx_standards_code ON public.standards USING btree (code);
CREATE INDEX IF NOT EXISTS idx_standards_org_id ON public.standards USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_standards_parent_id ON public.standards USING btree (parent_id);
CREATE INDEX IF NOT EXISTS idx_tech_stack_resources_tech_stack_id ON public.tech_stack_resources USING btree (tech_stack_id);
CREATE INDEX IF NOT EXISTS idx_tech_stack_standards_standard ON public.tech_stack_standards USING btree (standard_id);
CREATE INDEX IF NOT EXISTS idx_tech_stack_standards_tech_stack ON public.tech_stack_standards USING btree (tech_stack_id);
CREATE INDEX IF NOT EXISTS idx_tech_stacks_org_id ON public.tech_stacks USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_tech_stacks_parent_id ON public.tech_stacks USING btree (parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS profile_linked_projects_user_id_project_id_key ON public.profile_linked_projects USING btree (user_id, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_user_id_key ON public.profiles USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS project_repos_project_id_organization_repo_key ON public.project_repos USING btree (project_id, organization, repo);
CREATE UNIQUE INDEX IF NOT EXISTS project_standards_project_id_standard_id_key ON public.project_standards USING btree (project_id, standard_id);
CREATE UNIQUE INDEX IF NOT EXISTS project_tech_stacks_project_id_tech_stack_id_key ON public.project_tech_stacks USING btree (project_id, tech_stack_id);
CREATE UNIQUE INDEX IF NOT EXISTS project_tokens_token_key ON public.project_tokens USING btree (token);
CREATE UNIQUE INDEX IF NOT EXISTS published_projects_project_id_key ON public.published_projects USING btree (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS repo_files_repo_id_path_key ON public.repo_files USING btree (repo_id, path);
CREATE UNIQUE INDEX IF NOT EXISTS repo_pats_user_id_repo_id_key ON public.repo_pats USING btree (user_id, repo_id);
CREATE UNIQUE INDEX IF NOT EXISTS repo_staging_unique_file ON public.repo_staging USING btree (repo_id, file_path);
CREATE UNIQUE INDEX IF NOT EXISTS requirement_standards_requirement_id_standard_id_key ON public.requirement_standards USING btree (requirement_id, standard_id);
CREATE UNIQUE INDEX IF NOT EXISTS standards_code_key ON public.standards USING btree (code);
CREATE UNIQUE INDEX IF NOT EXISTS tech_stack_standards_tech_stack_id_standard_id_key ON public.tech_stack_standards USING btree (tech_stack_id, standard_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_id_role_key ON public.user_roles USING btree (user_id, role);


-- ======================================================================
-- SEED DATA: canvas_node_types
-- ======================================================================

INSERT INTO public.canvas_node_types (system_name, display_label, description, icon, emoji, color_class, order_score, category, is_legacy, is_active) VALUES
-- Meta types
('PROJECT', 'Project', 'Root application node', 'FolderKanban', '🎯', 'bg-cyan-500/10 border-cyan-500/50 text-cyan-700 dark:text-cyan-400', 100, 'meta', false, true),
('REQUIREMENT', 'Requirement', 'Functional requirement', 'FileText', '📋', 'bg-indigo-500/10 border-indigo-500/50 text-indigo-700 dark:text-indigo-400', 100, 'meta', false, true),
('STANDARD', 'Standard', 'Compliance standard', 'ListChecks', '📏', 'bg-teal-500/10 border-teal-500/50 text-teal-700 dark:text-teal-400', 100, 'meta', false, true),
('TECH_STACK', 'Tech Stack', 'Technology choice', 'Code', '🔧', 'bg-gray-500/10 border-gray-500/50 text-gray-700 dark:text-gray-400', 100, 'meta', false, true),
('SECURITY', 'Security', 'Security control', 'ShieldCheck', '🔒', 'bg-yellow-500/10 border-yellow-500/50 text-yellow-700 dark:text-yellow-400', 100, 'infrastructure', false, true),
-- Frontend types
('PAGE', 'Page', 'User-facing page/route', 'FileCode', '📄', 'bg-sky-500/10 border-sky-500/50 text-sky-700 dark:text-sky-400', 200, 'frontend', false, true),
('WEB_COMPONENT', 'Web Component', 'Frontend UI component', 'Box', '⚛️', 'bg-blue-500/10 border-blue-500/50 text-blue-700 dark:text-blue-400', 300, 'frontend', false, true),
('COMPONENT', 'Component', 'Legacy: UI component', 'Box', '⚛️', 'bg-blue-500/10 border-blue-500/50 text-blue-700 dark:text-blue-400', 300, 'frontend', true, true),
('HOOK_COMPOSABLE', 'Hook/Composable', 'Frontend hook or composable', 'Layers', '🪝', 'bg-violet-500/10 border-violet-500/50 text-violet-700 dark:text-violet-400', 400, 'frontend', false, true),
-- Backend types
('API_SERVICE', 'API Service', 'API service entry point', 'Server', '🌐', 'bg-green-500/10 border-green-500/50 text-green-700 dark:text-green-400', 500, 'backend', false, true),
('API_ROUTER', 'API Router', 'API routing layer', 'GitBranch', '🔀', 'bg-lime-500/10 border-lime-500/50 text-lime-700 dark:text-lime-400', 600, 'backend', false, true),
('API_MIDDLEWARE', 'API Middleware', 'API middleware handler', 'Filter', '⚙️', 'bg-amber-500/10 border-amber-500/50 text-amber-700 dark:text-amber-400', 600, 'backend', false, true),
('API', 'API', 'Legacy: API endpoint', 'Code', '🔌', 'bg-green-500/10 border-green-500/50 text-green-700 dark:text-green-400', 600, 'backend', true, true),
('API_CONTROLLER', 'API Controller', 'API controller logic', 'Cpu', '🎮', 'bg-emerald-500/10 border-emerald-500/50 text-emerald-700 dark:text-emerald-400', 700, 'backend', false, true),
('API_UTIL', 'API Utility', 'API utility functions', 'Wrench', '🔨', 'bg-stone-500/10 border-stone-500/50 text-stone-700 dark:text-stone-400', 700, 'backend', false, true),
('WEBHOOK', 'Webhook', 'Webhook handler', 'Webhook', '📡', 'bg-pink-500/10 border-pink-500/50 text-pink-700 dark:text-pink-400', 700, 'backend', false, true),
-- Infrastructure types
('EXTERNAL_SERVICE', 'External Service', 'Third-party service integration', 'Globe', '🌍', 'bg-orange-500/10 border-orange-500/50 text-orange-700 dark:text-orange-400', 800, 'infrastructure', false, true),
('SERVICE', 'Service', 'Legacy: External service', 'Globe', '⚙️', 'bg-orange-500/10 border-orange-500/50 text-orange-700 dark:text-orange-400', 800, 'infrastructure', true, true),
('FIREWALL', 'Firewall', 'Firewall/security layer', 'Shield', '🛡️', 'bg-red-500/10 border-red-500/50 text-red-700 dark:text-red-400', 800, 'infrastructure', false, true),
-- Database types
('DATABASE', 'Database', 'Database container', 'Database', '🗄️', 'bg-purple-500/10 border-purple-500/50 text-purple-700 dark:text-purple-400', 900, 'database', false, true),
('SCHEMA', 'Schema', 'Database schema', 'TableProperties', '📊', 'bg-fuchsia-500/10 border-fuchsia-500/50 text-fuchsia-700 dark:text-fuchsia-400', 950, 'database', false, true),
('TABLE', 'Table', 'Database table', 'Table2', '📋', 'bg-rose-500/10 border-rose-500/50 text-rose-700 dark:text-rose-400', 1000, 'database', false, true),
-- Flexible types
('AGENT', 'Agent', 'AI Agent component', 'Bot', '🤖', 'bg-cyan-600/10 border-cyan-600/50 text-cyan-800 dark:text-cyan-300', 500, 'agent', false, true),
('OTHER', 'Other', 'Generic/miscellaneous node', 'MoreHorizontal', '❓', 'bg-slate-500/10 border-slate-500/50 text-slate-700 dark:text-slate-400', 500, 'general', false, true),
-- Annotation types
('NOTES', 'Notes', 'Resizable markdown notes for documentation', 'FileText', '📝', 'bg-amber-500/10 border-amber-500/50 text-amber-700 dark:text-amber-400', 10, 'annotation', false, true),
('ZONE', 'Zone', 'Resizable background zone for grouping nodes', 'Square', '🔲', 'bg-slate-500/10 border-slate-500/50 text-slate-700 dark:text-slate-400', 11, 'annotation', false, true),
('LABEL', 'Label', 'Simple resizable text label', 'Type', '🏷️', 'bg-stone-500/10 border-stone-500/50 text-stone-700 dark:text-stone-400', 12, 'annotation', false, true)
ON CONFLICT (system_name) DO NOTHING;
