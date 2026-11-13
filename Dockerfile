FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 DATA_DIR=/data PORT=8000
WORKDIR /app
COPY app/ /app/
VOLUME ["/data"]
EXPOSE 8000
CMD ["python", "server.py"]
