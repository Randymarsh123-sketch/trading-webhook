export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const data = request.body;  // JSON fra TradingView
    console.log("Received from TradingView:", data);

    return response.status(200).json({ ok: true });
  } 
  catch (err) {
    console.error("Error:", err);
    return response.status(500).json({ error: "Server error" });
  }
}
