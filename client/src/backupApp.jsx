import { useEffect, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";

// 🔌 connect to backend
const socket = io("http://192.168.1.160:5000");

function App() {
  const [file, setFile] = useState(null);
  const [files, setFiles] = useState([]);

  // fetch initial files
  const fetchFiles = async () => {
    try {
      const res = await axios.get("http://192.168.1.160:5000/files");
      setFiles(res.data);
    } catch (err) {
      console.log(err);
    }
  };

  useEffect(() => {
    fetchFiles();

    // 🔥 listen for real-time updates
    socket.on("new_file", (newFile) => {
      setFiles((prev) => [newFile, ...prev]);
    });

    return () => {
      socket.off("new_file");
    };
  }, []);

  const uploadFile = async () => {
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    try {
      await axios.post("http://192.168.1.160:5000/upload", formData);
      setFile(null);
      // ❌ no fetchFiles() needed (real-time handles it)
    } catch (err) {
      console.log(err);
    }
  };

  return (
    <div style={{ padding: "20px" }}>
      <h2>SpaceSync 🚀</h2>

      <input type="file" onChange={(e) => setFile(e.target.files[0])} />
      <button onClick={uploadFile}>Upload</button>

      <h3>Your Files</h3>
      {files.map((f) => (
        <div key={f._id}>
          <a
            href={`http://192.168.1.160:5000/${f.path}`}
            target="_blank"
            rel="noreferrer"
          >
            {f.filename}
          </a>
        </div>
      ))}
    </div>
  );
}

export default App;