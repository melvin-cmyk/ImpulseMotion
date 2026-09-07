-- Entrepôt client_data — commandes e-commerce des clients (Magento LPEV, Shopify demain).
-- Toutes les tables portent client_key = ClientBot.clientKey. Idempotent.

CREATE SCHEMA IF NOT EXISTS client_data;

CREATE TABLE IF NOT EXISTS client_data.orders (
  client_key           text        NOT NULL,
  order_id             text        NOT NULL,
  entity_id            text,
  created_at           timestamptz,
  updated_at           timestamptz,
  status               text,
  grand_total          numeric,
  subtotal             numeric,
  shipping_amount      numeric,
  tax_amount           numeric,
  discount_amount      numeric,
  total_qty            numeric,
  currency             text        DEFAULT 'EUR',
  customer_id          text,
  customer_is_guest    boolean,
  customer_key         text,
  customer_created_at  timestamptz,
  customer_group       text,
  store_id             text,
  payment_method       text,
  shipping_method      text,
  coupon_code          text,
  billing_country      text,
  prescriber_code      text,
  prescriber_type      text,
  attrs                jsonb       DEFAULT '{}'::jsonb,
  ingested_at          timestamptz DEFAULT now(),
  PRIMARY KEY (client_key, order_id)
);

CREATE INDEX IF NOT EXISTS orders_client_created_idx  ON client_data.orders (client_key, created_at);
CREATE INDEX IF NOT EXISTS orders_client_customer_idx ON client_data.orders (client_key, customer_key);

CREATE TABLE IF NOT EXISTS client_data.order_items (
  client_key    text    NOT NULL,
  order_id      text    NOT NULL,
  line_no       int     NOT NULL,
  sku           text,
  product_name  text,
  qty           numeric,
  unit_price    numeric,
  row_total     numeric,
  product_id    text,
  product_type  text,
  attrs         jsonb   DEFAULT '{}'::jsonb,
  PRIMARY KEY (client_key, order_id, line_no)
);

CREATE INDEX IF NOT EXISTS order_items_client_sku_idx ON client_data.order_items (client_key, sku);
