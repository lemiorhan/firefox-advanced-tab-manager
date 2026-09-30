// Main popup logic
document.getElementById("groupForm").addEventListener("submit", (e) => {
  handleFormSubmit(e, "groupList");
});

document.getElementById("cancelBtn").addEventListener("click", cancelEdit);

// Open settings page
document.getElementById("openSettings").addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
});

refreshList("groupList");

