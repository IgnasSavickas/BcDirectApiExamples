import { useState } from "react";
import { SetupPage } from "./pages/Setup.js";
import { CustomersPage } from "./pages/Customers.js";
import { LiveEntity } from "./pages/LiveEntity.js";
import { DeliverySheet } from "./pages/DeliverySheet.js";
import { SalesOrders } from "./pages/SalesOrders.js";
import { PlanningWorksheet } from "./pages/PlanningWorksheet.js";

type Tab =
  | "setup"
  | "customers"
  | "items"
  | "purchaseOrders"
  | "salesOrders"
  | "planning"
  | "delivery";

export function App() {
  const [tab, setTab] = useState<Tab>("setup");

  return (
    <div className="app">
      <header>
        <h1>BC Data</h1>
        <nav>
          <button className={tab === "setup" ? "active" : ""} onClick={() => setTab("setup")}>
            Setup
          </button>
          <button
            className={tab === "customers" ? "active" : ""}
            onClick={() => setTab("customers")}
          >
            Customers
          </button>
          <button className={tab === "items" ? "active" : ""} onClick={() => setTab("items")}>
            Items (live)
          </button>
          <button
            className={tab === "purchaseOrders" ? "active" : ""}
            onClick={() => setTab("purchaseOrders")}
          >
            Purchase Orders (live)
          </button>
          <button
            className={tab === "salesOrders" ? "active" : ""}
            onClick={() => setTab("salesOrders")}
          >
            Sales Orders (live)
          </button>
          <button
            className={tab === "planning" ? "active" : ""}
            onClick={() => setTab("planning")}
          >
            Planning worksheet
          </button>
          <button
            className={tab === "delivery" ? "active" : ""}
            onClick={() => setTab("delivery")}
          >
            Delivery Sheet
          </button>
        </nav>
      </header>
      <main>
        {tab === "setup" && <SetupPage />}
        {tab === "customers" && <CustomersPage />}
        {tab === "items" && (
          <LiveEntity entity="items" title="Items — live from Business Central" />
        )}
        {tab === "purchaseOrders" && (
          <LiveEntity
            entity="purchaseOrders"
            title="Purchase Orders — live from Business Central"
            subtitle="Direct fields only, 30 per page (native BC paging). Select rows for bulk actions."
            actions={[{ name: "receiveAndInvoice", label: "Receive and Invoice" }]}
          />
        )}
        {tab === "salesOrders" && <SalesOrders />}
        {tab === "planning" && <PlanningWorksheet />}
        {tab === "delivery" && <DeliverySheet />}
      </main>
    </div>
  );
}
