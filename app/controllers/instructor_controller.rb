# Base for everything an instructor does: hosting, editing, reports.
# Apache requires a Shibboleth session on these paths; this is the second lock.
class InstructorController < ApplicationController
  before_action :require_user
end
