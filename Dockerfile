# Use official Node.js image based on Debian slim (supports Python install)
FROM node:22-slim

# Install Python, pip, and required system dependencies
RUN echo "Acquire::http::Pipeline-Depth 0;" > /etc/apt/apt.conf.d/99custom && \
    echo "Acquire::http::No-Cache true;" >> /etc/apt/apt.conf.d/99custom && \
    echo "Acquire::BrokenProxy true;" >> /etc/apt/apt.conf.d/99custom

RUN apt-get clean && apt-get update --fix-missing -o Acquire::CompressionTypes::Order::=gz && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /usr/src/app

# Set up Python virtual environment to avoid PEP 668 external managed environment errors
ENV VIRTUAL_ENV=/usr/src/app/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Copy package.json and Python requirements first for better caching
COPY package*.json ./
COPY requirements.txt ./

# Install Python dependencies inside the virtual environment
RUN pip3 install --no-cache-dir -r requirements.txt

# Install Node.js dependencies
RUN npm install

# Copy all source files (respects .dockerignore)
COPY . .

# Build the Vite React Frontend
RUN npm run build

# Expose the dynamically assigned port (Render assigns process.env.PORT)
EXPOSE 3001

# Start the Express server
CMD ["npm", "start"]
