FROM python:3.11-slim

WORKDIR /app

# Install minimal deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY config.py x1_rpc.py prices.py events.py messages.py storage.py bot.py ./

# Bot has no inbound HTTP — pure poller
CMD ["python", "bot.py"]
